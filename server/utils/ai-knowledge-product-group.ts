/**
 * 分組就是商品（`D-127`，2026-10-16 老闆拍板）：資料放在哪一組＝在講哪一台，這份的商品名跟著組名走。
 *
 * 為什麼：AI 只看每份資料的商品名、不看分組。`C-320` 時代商品名是每份自己的（加入時 AI 想、店家可改），
 * 一台商品的名字散在三處、寫法會分裂；現在只有組名一處，別的寫法收成那一組的別名。
 * 規則（什麼時候是組名、什麼時候是空的）在 shared/knowledge-product-group 的 productNameForGroup。
 *
 * 呼叫端：
 *  · PUT /api/ai/sources/:id 換了分組（拖進另一組、「移到哪一組」）→ syncSourceProductWithGroup，**當場重新學習**這一份
 *  · PUT /api/ai/folders/:id 改組名、改成／取消通用 → syncGroupSourcesProduct，只改名字、回「要重新學的那幾份」給畫面一份份學
 *    （一組可能好幾份、幾百條，一個請求學不完）
 *  · 搬家腳本 scripts/migrate-kb-group-is-product.mjs
 * 商品名要進到每一條的向量裡才生效，只改資料上那一格，AI 照舊用舊的名字——所以一定要重新學習。
 */
import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore'
import { getSource, updateSourceSettings, KNOWLEDGE_SOURCES_COLLECTION, type SourceSummary } from './ai-knowledge-sources'
import { KNOWLEDGE_FOLDERS_COLLECTION } from './ai-knowledge-folders'
import {
  addWorkspaceProductName,
  buildEmbeddingText,
  invalidateSourceProductCache,
  invalidateWorkspaceProductNames,
  KNOWLEDGE_CHUNKS_COLLECTION,
  runIndexOnChunk,
} from './ai-knowledge-chunks'
import { confirmAlias, invalidateProductAliases, promoteCanonicalName } from './ai-product-alias'
import { getMaintenanceBudgetStatus, recordAiUsage } from './ai-usage'
import { runWithLlmBudget } from './gemini'
import { writeAuditLog } from './audit-log'
import { productNameForGroup, sameProductGroupName } from '~~/shared/knowledge-product-group'
import { isUsableAlias } from '~~/shared/product-name-similarity'
import type { KnowledgeFolderDoc } from '~~/shared/types/ai-knowledge'

/** 與 reindex / bulk-create 一致的保守併發 */
const EMBED_CONCURRENCY = 5

export interface SourceRelearnResult {
  total: number
  /** 停用的、沒內容的跳過（重新學習不偷偷把停用的打開） */
  skipped: number
  /** 照新的學好了（⛔ 不含 kept） */
  indexed: number
  /** 沒學成、AI 找不到（從來沒學好過的那種） */
  failed: number
  /**
   * 重學沒成、AI 先用原本學好的（`C-351`）：客人問到照樣答得出來，排程會自己再學。
   * ⛔ 不算在 failed（畫面不講「還沒學會」）、也不算在 indexed（操作紀錄不講成學會了）。
   */
  kept: number
  failures: Array<{ id: string; status: string; failureReason?: string }>
}

/** 操作紀錄備註接在「學會 N 條」後面那一段（`D-129` 不講「重新學習」；`C-351` 先用原本的那幾條另外講） */
export function relearnTailNote(r: Pick<SourceRelearnResult, 'failed' | 'kept'>): string {
  return (r.failed ? `、${r.failed} 條還沒學會（會自己再試）` : '')
    + (r.kept ? `、${r.kept} 條先用原本學好的（會自己再學）` : '')
}

/**
 * 讓一份資料底下的每一條重新學習（重算向量，產品名在這一步前置進去）。
 * POST /api/ai/sources/:id/reindex 也用這一份迴圈：
 * 停用的跳過（runIndexOnChunk 會把狀態寫回 indexed）、「等你看過」的照樣算向量但狀態不變（runIndexOnChunk 自己守）、
 * 逐條不記帳、最後記一次（同一份月用量文件連打會被節流、靜默漏記）。冪等，可重跑。
 */
export async function relearnSourceChunks(db: Firestore, workspaceId: string, sourceId: string): Promise<SourceRelearnResult> {
  // 來源產品名的 60 秒快取先失效，這一輪才吃得到剛存的新值
  invalidateSourceProductCache(sourceId)
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .select('title', 'content', 'questions', 'status')
    .get()
  const docs = snap.docs.filter(d => String(d.data()?.content ?? '').trim() && d.data()?.status !== 'disabled')

  const results: Array<SourceRelearnResult['failures'][number] & { keptPrevious?: true }> = new Array(docs.length)
  let embeddingTokens = 0
  let cursor = 0
  async function worker() {
    while (cursor < docs.length) {
      const idx = cursor++
      const doc = docs[idx]!
      const data = doc.data()
      const r = await runIndexOnChunk(
        db,
        doc.id,
        buildEmbeddingText(
          String(data?.title ?? ''),
          String(data?.content ?? ''),
          Array.isArray(data?.questions) ? data.questions.map(String) : [],
        ),
      )
      if (r.status !== 'failed') embeddingTokens += r.embeddingTokens
      results[idx] = { id: r.id, status: r.status, failureReason: r.failureReason, ...(r.keptPrevious ? { keptPrevious: true as const } : {}) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, docs.length) }, worker))
  if (embeddingTokens > 0) await recordAiUsage(workspaceId, { buildEmbeddingTokens: embeddingTokens }, db)

  const failures = results.filter(r => r.status === 'failed').map(({ keptPrevious: _k, ...f }) => f)
  // `C-351`：重學沒成、AI 先用原本學好的——每一條自己帶著「還要重學」的記號（排程 retryStuckChunks 撿），
  // 所以下面這份資料上的記號照樣拿掉（不然 relearnPendingProductSources 會整份再學一次、學好的那幾條白花錢）
  const kept = results.filter(r => r.keptPrevious).length
  // 學完了：「商品名換了、還沒重新學」的記號拿掉（體檢靠它找沒學完的，見 RELEARN_PENDING_FIELD）。
  // 學失敗的那幾條另外有「AI 沒學起來」那一列在管。清不掉不擋（下次學再清）
  try {
    await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({ [RELEARN_PENDING_FIELD]: FieldValue.delete() })
  }
  catch { /* 資料剛被刪掉、或假資料庫沒有 update */ }
  return {
    total: snap.size,
    skipped: snap.size - docs.length,
    indexed: results.length - failures.length - kept,
    failed: failures.length,
    kept,
    failures,
  }
}

/**
 * 「商品名換了、AI 還沒重新學」的記號（資料上的一格，`D-127` /code-review 第 4、14 條）。
 * 改組名、改成通用、刪分組、合成一組時伺服器只改名字，重新學習交給畫面一份份打——他中途關掉頁面就停在一半，
 * 卡片還帶舊商品名（產品鎖照舊名字擋）。有這個記號，排程就找得到沒學完的、自己補完（relearnPendingProductSources，`D-129`；
 * 以前是體檢「要處理的事」列出來叫他按一下補學）。relearnSourceChunks 學完就拿掉。
 */
export const RELEARN_PENDING_FIELD = 'productRelearnPending'

/**
 * 排程補學的節奏（`D-129`）：
 *  · 等 10 分鐘才接手：記號剛留下時，畫面多半正在一份份學（一組十幾份、幾分鐘內學完）——搶同一份＝同一份學兩次、錢花兩次。
 *    畫面中途關掉的那幾份，最多晚 20 分鐘學好；在那之前舊名字已經收成別名，客人照舊名字叫也認得是這一台。
 *  · 一輪最多看 20 份、過了 12 秒就不開下一份：一份最多約 150 條、約 9 秒（同 reindex 端點），排程那支閘道 30 秒，
 *    還要跟其他二十幾項一起跑。學不完的下一輪（10 分鐘後）再接。
 */
export const RELEARN_PENDING_GRACE_MS = 10 * 60_000
export const RELEARN_PENDING_SOURCES_PER_ROUND = 20
export const RELEARN_PENDING_TIME_BUDGET_MS = 12_000
/** 一輪最多處理幾個「改了組名、底下資料沒跟上」的分組（分組上的 productSyncPending） */
const RELEARN_PENDING_FOLDERS_PER_ROUND = 10

export interface RelearnPendingResult {
  /** 分組上「沒跟上」的記號，這輪補上幾組（底下的資料接著留記號、照下面那條路學） */
  foldersSynced: number
  /** 這輪學完幾份 */
  relearned: number
  indexed: number
  failed: number
  /** 重學沒成、AI 先用原本學好的條數（`C-351`，每一條自己帶記號、retryStuckChunks 接手） */
  kept: number
  /** 還在等畫面學（記號剛留下不到 10 分鐘）的份數 */
  waitingForPage: number
  /**
   * 這個帳號本月 AI 整理用量用完了，這輪先不學的份數（學下去每一條都被額度擋下：
   * 本來學好的那幾條 `C-351` 起會先用原本的、不會下架，但從來沒學好的那幾條會變成學失敗——打了也是白打，下月再學）
   */
  skippedBudget: number
  /** 時間到、下一輪再接的份數 */
  deferred: number
  /** 資料已經刪掉了、只把記號拿掉的份數 */
  cleared: number
}

/**
 * 改組名、改成通用、刪分組、合成一組之後，畫面中途關掉、沒學完的那幾份——伺服器自己補完（`D-129`，2026-10-19 老闆「按你建議」）。
 * 以前要他在「要處理的事」看到「有 N 份資料換了商品名，AI 還沒重新學」、自己按「重新學習」；現在那一列拿掉了，排程自己來。
 *
 * ① 分組上有 productSyncPending（改組名時底下資料的商品名寫失敗）→ 重跑一次 syncGroupSourcesProduct，底下資料改名＋留記號；
 * ② 資料上有 productRelearnPending、而且留下超過 10 分鐘 → 先對齊組名、再整份學一次（同畫面打的 reindex 端點）。
 *    學失敗的那幾條另外由 retryStuckChunks 自動再試（那幾條本身已經是 failed；本來學好、重學沒成的那幾條
 *    先用原本的、帶著 relearnState='retrying'，也是 retryStuckChunks 撿，`C-351`）。
 * 稽核記成系統排程（⛔ 不掛在當初改組名的人頭上：學的那一刻他不在場）。
 */
export async function relearnPendingProductSources(
  db: Firestore,
  opts: { now?: () => number; graceMs?: number; perRound?: number; timeBudgetMs?: number } = {},
): Promise<RelearnPendingResult> {
  const now = opts.now ?? Date.now
  const startedAt = now()
  const graceMs = opts.graceMs ?? RELEARN_PENDING_GRACE_MS
  const perRound = opts.perRound ?? RELEARN_PENDING_SOURCES_PER_ROUND
  const timeBudgetMs = opts.timeBudgetMs ?? RELEARN_PENDING_TIME_BUDGET_MS
  const result: RelearnPendingResult = { foldersSynced: 0, relearned: 0, indexed: 0, failed: 0, kept: 0, waitingForPage: 0, skippedBudget: 0, deferred: 0, cleared: 0 }

  // ① 分組上「沒跟上」的記號：畫面那時拿到 syncFailed、沒有一份份學——沒人在學，底下的資料不用等 10 分鐘
  const readyNow = new Set<string>()
  const folderSnap = await db.collection(KNOWLEDGE_FOLDERS_COLLECTION)
    .where('productSyncPending', '==', true)
    .limit(RELEARN_PENDING_FOLDERS_PER_ROUND)
    .get()
  for (const d of folderSnap.docs) {
    const wid = String((d.data() as Partial<KnowledgeFolderDoc>).workspaceId ?? '')
    if (!wid) continue
    try {
      const ids = await syncGroupSourcesProduct(db, wid, d.id)
      for (const id of ids) readyNow.add(id)
      result.foldersSynced++
    }
    catch (e) {
      console.warn(`[ai:relearn-pending-sources] 分組 ${d.id} 底下的商品名還是沒跟上:`, (e as Error)?.message)
    }
  }

  // ② 資料上「還沒重新學」的記號（兩個等值條件都不用：單一欄位等值，自動索引就查得到）
  const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
    .where(RELEARN_PENDING_FIELD, '==', true)
    .select('workspaceId', 'name', 'updatedAt', 'isDeleted', 'deletedAt')
    .limit(perRound)
    .get()
  const budgetByWorkspace = new Map<string, boolean>()
  for (const d of snap.docs) {
    const s = d.data() as { workspaceId?: string; name?: string; updatedAt?: { toMillis?: () => number }; isDeleted?: boolean; deletedAt?: unknown }
    const wid = String(s.workspaceId ?? '')
    if (!wid || s.isDeleted === true || s.deletedAt != null) {
      // 刪掉的資料不用學了；記號不拿掉的話每一輪都撿到它、佔掉名額
      await d.ref.update({ [RELEARN_PENDING_FIELD]: FieldValue.delete() }).catch(() => {})
      result.cleared++
      continue
    }
    const updatedMs = typeof s.updatedAt?.toMillis === 'function' ? s.updatedAt.toMillis() : 0
    if (!readyNow.has(d.id) && updatedMs > 0 && startedAt - updatedMs < graceMs) {
      result.waitingForPage++
      continue
    }
    if (now() - startedAt >= timeBudgetMs) {
      result.deferred++
      continue
    }
    if (!budgetByWorkspace.has(wid)) {
      budgetByWorkspace.set(wid, await getMaintenanceBudgetStatus(wid, db).then(b => b.blocked).catch(() => false))
    }
    if (budgetByWorkspace.get(wid)) {
      result.skippedBudget++
      continue
    }
    try {
      // 圈進這個帳號的額度境域：排程沒有請求可以帶出是哪一家，不圈的話用量守門形同關掉
      const r = await runWithLlmBudget(wid, async () => {
        await alignSourceProductWithGroup(db, wid, d.id)
        return relearnSourceChunks(db, wid, d.id)
      }, 'knowledge')
      result.relearned++
      result.indexed += r.indexed
      result.failed += r.failed
      result.kept += r.kept
      await writeAuditLog({
        workspaceId: wid,
        uid: '',
        actor: 'system',
        action: 'source.reindex',
        targetId: d.id,
        after: { name: String(s.name ?? ''), itemsCount: r.total, chunkIdsCount: r.indexed, failedItemsCount: r.failed, ...(r.kept ? { keptPreviousCount: r.kept } : {}) },
        note: `${String(s.name ?? '')}：換了商品名之後沒學完的，系統自己補學：學會 ${r.indexed} 條${relearnTailNote(r)}`,
      }, db)
    }
    catch (e) {
      // 記號留著：下一輪再試
      console.warn(`[ai:relearn-pending-sources] ${d.id} 補學沒成:`, (e as Error)?.message)
    }
  }
  return result
}

/** Firestore 一個 batch 最多 500 筆：分批寫（每批 400 留餘裕）。一組底下超過 500 份時，以前整批 commit 失敗、什麼都沒寫 */
async function commitUpdatesInChunks(db: Firestore, updates: Array<{ ref: DocumentReference, data: Record<string, unknown> }>): Promise<void> {
  for (let i = 0; i < updates.length; i += 400) {
    const batch = db.batch()
    for (const u of updates.slice(i, i + 400)) batch.update(u.ref, u.data)
    await batch.commit()
  }
}

/** 這一家的這一組（別家的、不存在的＝null） */
async function readGroup(db: Firestore, workspaceId: string, folderId: string | null | undefined): Promise<(KnowledgeFolderDoc & { id: string }) | null> {
  if (!folderId) return null
  const snap = await db.collection(KNOWLEDGE_FOLDERS_COLLECTION).doc(folderId).get()
  const folder = snap.data() as KnowledgeFolderDoc | undefined
  return snap.exists && folder?.workspaceId === workspaceId ? { ...folder, id: folderId } : null
}

/**
 * 放進這一組的資料該掛哪個商品名（`D-127`）：加入資料（bulk-create／create）時伺服器自己決定，
 * ⛔ 不收畫面送來的商品名——那是 AI 猜的，可能跟它放進的組不一樣（又回到一台商品好幾種寫法）。
 */
export async function productNameForFolderId(
  db: Firestore,
  workspaceId: string,
  folderId: string | null | undefined,
  flags: { isCatalog?: boolean; isSheet?: boolean } = {},
): Promise<string> {
  return productNameForGroup(await readGroup(db, workspaceId, folderId), flags)
}

export type SourceGroupSyncResult =
  | { changed: false; productName: string; notFound?: true }
  | {
    changed: true
    /** 現在的商品名（''＝不是講單一商品） */
    productName: string
    /** 改之前的 */
    previous: string
    /** 改完之後這份資料的樣子（呼叫端回給畫面用這份，不要回改之前那份） */
    source: SourceSummary
    relearned: SourceRelearnResult
  }

/**
 * 這份資料的商品名改成跟它現在所在的分組一致（`D-127`），有變才存、才當場重新學習。
 *
 * ⚠️ 要在**分組已經換好之後**呼叫（讀的是這份資料現在的 folderId）。
 * ⚠️ 會花 embedding 的錢（一份最多約 150 條），只在真的換了分組時呼叫，⛔ 不要每次存設定都打。
 */
export async function syncSourceProductWithGroup(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  /** actor 預設 human（搬組的人）；搬家腳本傳 system、uid 空字串（⛔ 不掛在任何人頭上） */
  ctx: { uid: string; actor?: 'human' | 'system' },
): Promise<SourceGroupSyncResult> {
  const aligned = await alignSourceProductWithGroup(db, workspaceId, sourceId)
  if (!aligned.changed) return aligned.notFound ? { changed: false, productName: '', notFound: true } : { changed: false, productName: aligned.productName }
  const { source, group, previous, productName: target, updated } = aligned
  const relearned = await relearnSourceChunks(db, workspaceId, sourceId)

  // 稽核（`C-254`）：商品名換掉＝整份資料歸屬的商品換了（答錯台的老毛病），⛔ 失敗條數一定要一起記
  await writeAuditLog({
    workspaceId,
    uid: ctx.uid,
    actor: ctx.actor ?? 'human',
    action: 'source.put',
    targetId: sourceId,
    before: { productName: previous },
    after: { productName: target, chunkIdsCount: relearned.indexed, failedItemsCount: relearned.failed, ...(relearned.kept ? { keptPreviousCount: relearned.kept } : {}) },
    note: `${String(source.data.name ?? '')}：`
      + (target ? `放進「${group?.name ?? ''}」，AI 把它當成「${target}」的資料` : `不在商品分組裡，AI 不再把它當成「${previous}」的資料`)
      // `D-129`：店家看得到的字不講「重新學習」；沒學會的那幾條排程會自己再試（`C-351` 先用原本的那幾條另外講）
      + `，照新的商品名學會 ${relearned.indexed} 條${relearnTailNote(relearned)}`,
  }, db)

  return { changed: true, productName: target, previous, source: updated, relearned }
}

/**
 * 一整組的資料商品名改成跟這一組一致（`D-127`：改組名、改成／取消通用之後）。
 * **只改名字、不重新學習**，回改到的那幾份 id——呼叫端（畫面）再一份份打 POST /api/ai/sources/:id/reindex。
 * 為什麼不在這裡學：一組可能好幾份、幾百條，一個請求學不完（閘道 30 秒）。
 * 學完之前 AI 用的還是舊名字：改組名時舊名字會先收成別名（folders PUT），舊名字照樣認得是這一台。
 */
export async function syncGroupSourcesProduct(
  db: Firestore,
  workspaceId: string,
  folderId: string,
): Promise<string[]> {
  const group = await readGroup(db, workspaceId, folderId)
  if (!group) return []
  // 兩個等值條件走自動索引（同 deleteFolderCascade 那一句），不用另建複合索引
  const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('folderId', '==', folderId)
    .select('productName', 'generateOverview', 'type')
    .get()
  const changed: string[] = []
  const updates: Array<{ ref: DocumentReference, data: Record<string, unknown> }> = []
  for (const d of snap.docs) {
    const s = d.data() as { productName?: string; generateOverview?: boolean; type?: string }
    const target = productNameForGroup(group, { isCatalog: s.generateOverview === true, isSheet: s.type === 'gsheet' })
    if (String(s.productName ?? '').trim() === target) continue
    // 商品名換了、卡片還沒重新學 → 留記號（學完 relearnSourceChunks 拿掉；畫面中途關掉的話體檢找得到）
    updates.push({ ref: d.ref, data: { productName: target || FieldValue.delete(), [RELEARN_PENDING_FIELD]: true, updatedAt: FieldValue.serverTimestamp() } })
    changed.push(d.id)
  }
  // 上一次沒跟上的這次整組跟上了 → 拿掉分組上的記號（見 KnowledgeFolderDoc.productSyncPending）
  const clearGroupPending = async () => {
    if (group.productSyncPending !== true) return
    await db.collection(KNOWLEDGE_FOLDERS_COLLECTION).doc(folderId).update({ productSyncPending: FieldValue.delete() }).catch(() => {})
  }
  if (!changed.length) {
    await clearGroupPending()
    return []
  }
  await commitUpdatesInChunks(db, updates)
  await clearGroupPending()
  for (const id of changed) invalidateSourceProductCache(id)
  invalidateWorkspaceProductNames(workspaceId)
  const name = productNameForGroup(group)
  if (name) await addWorkspaceProductName(db, workspaceId, name)
  return changed
}

/**
 * 改了組名、底下資料的商品名卻沒跟上（寫入失敗）→ 在分組上留記號（`D-127` /code-review 第 14 條）。
 * 資料上的「還沒重新學」記號跟商品名是同一筆寫入，寫失敗兩個都沒有；分組這一格讓體檢還找得到它們。
 */
export async function markGroupProductSyncPending(db: Firestore, folderId: string): Promise<void> {
  await db.collection(KNOWLEDGE_FOLDERS_COLLECTION).doc(folderId).update({ productSyncPending: true })
}

/**
 * 這份資料的商品名改成跟它所在分組一致，**不學**（`D-127`）。有變就留「還沒重新學」的記號。
 * syncSourceProductWithGroup（換組當場學）、POST /api/ai/sources/:id/reindex（畫面改組名之後一份份學）、
 * 排程 relearnPendingProductSources（畫面中途關掉的，`D-129`）都走這裡——改組名到一半斷掉、資料上的商品名沒跟上組名的，
 * 學那一次就對齊（/code-review 第 14 條）。
 */
export async function alignSourceProductWithGroup(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
): Promise<
  | { changed: false; productName: string; notFound?: true }
  | { changed: true; productName: string; previous: string; source: NonNullable<Awaited<ReturnType<typeof getSource>>>; group: Awaited<ReturnType<typeof readGroup>>; updated: SourceSummary }
> {
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) return { changed: false, productName: '', notFound: true }
  const group = await readGroup(db, workspaceId, source.data.folderId)
  const target = productNameForGroup(group, {
    isCatalog: source.data.generateOverview === true,
    isSheet: source.data.type === 'gsheet',
  })
  const previous = String(source.data.productName ?? '').trim()
  if (previous === target) return { changed: false, productName: target }
  // 跟以前「AI 認的商品名」存檔同一條路：updateSourceSettings 存名字（也會清快取）
  const updated = await updateSourceSettings(db, workspaceId, sourceId, { productName: target })
  if (!updated) return { changed: false, productName: '', notFound: true }
  try {
    await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({ [RELEARN_PENDING_FIELD]: true })
  }
  catch { /* 記號寫不進去不擋：接著就會學 */ }
  return { changed: true, productName: target, previous, source, group, updated }
}

/**
 * 組名一定是正式名（`D-127`）：組名本來是某條別名的，拿掉那一條（promoteCanonicalName），
 * 它原本指向的名字收成這一組的別名——兩個名字本來就被當成同一台，只是換個方向；不收的話那個舊名字跟這一組就斷了，
 * 客人那樣叫 AI 認不得（MYFEEL「Poketomo 口袋同萌」原本指向「SHARP 小獴友 Poketomo 口袋同萌」，拿掉之後「小獴友」就沒人認）。
 * ⛔ 原本指向的是**另一個商品分組**的組名＝不收：他另外建了這一組，就是要分成兩台（收了等於又併回去）。太短的也不收（同 C-323）。
 * 建商品分組、改組名、改回商品分組、合成一組都走這裡。回收回來的那個名字（''＝沒有）。
 */
export async function makeGroupNameCanonical(db: Firestore, workspaceId: string, name: string, folderId: string): Promise<string> {
  const previous = await promoteCanonicalName(db, workspaceId, name)
  if (!previous || sameProductGroupName(previous, name) || !isUsableAlias(previous)) return ''
  const groups = await db.collection(KNOWLEDGE_FOLDERS_COLLECTION).where('workspaceId', '==', workspaceId).get()
  const otherGroup = groups.docs.some((d) => {
    const g = d.data() as Partial<KnowledgeFolderDoc>
    return d.id !== folderId && g.general !== true && sameProductGroupName(String(g.name ?? ''), previous)
  })
  if (otherGroup) return ''
  return (await confirmAlias(db, workspaceId, name, previous)) ? previous : ''
}

export interface GroupMergeResult {
  /** 搬過去的份數 */
  moved: number
  /** 商品名換了、要重新學的那幾份（畫面一份份打 reindex） */
  relearnSourceIds: string[]
  /** 舊組名收成了留下那一組的別名（太短、或本來就是同一個名字＝''） */
  aliasFrom: string
}

/**
 * 兩組其實是同一台 → 把 from 合進 into（`D-127` 同一台只能有一組；/code-review 第 9、10 條）。
 * 伺服器照 folderId 查**全部**資料搬（畫面清單可能被截斷、看不到的那幾份以前會被刪分組移到未分類），
 * 商品名換成 into 的組名、留「還沒重新學」記號；舊組名收成別名；刪掉變空的 from。只改名字、不學（同 syncGroupSourcesProduct）。
 */
export async function mergeProductGroupInto(
  db: Firestore,
  workspaceId: string,
  fromId: string,
  intoId: string,
): Promise<GroupMergeResult & { fromName: string; intoName: string }> {
  if (fromId === intoId) throw createError({ statusCode: 400, statusMessage: '同一組不用合' })
  const [from, into] = await Promise.all([readGroup(db, workspaceId, fromId), readGroup(db, workspaceId, intoId)])
  if (!from || !into) throw createError({ statusCode: 404, statusMessage: '找不到要合的分組（可能已被刪除），請重新整理後再試' })
  if (from.general === true || into.general === true) throw createError({ statusCode: 400, statusMessage: '通用的分組不講單一商品，不能合成一組' })

  const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('folderId', '==', fromId)
    .select('productName', 'generateOverview', 'type')
    .get()
  const relearn: string[] = []
  const updates: Array<{ ref: DocumentReference, data: Record<string, unknown> }> = []
  for (const d of snap.docs) {
    const s = d.data() as { productName?: string; generateOverview?: boolean; type?: string }
    const target = productNameForGroup(into, { isCatalog: s.generateOverview === true, isSheet: s.type === 'gsheet' })
    const productChanged = String(s.productName ?? '').trim() !== target
    if (productChanged) relearn.push(d.id)
    updates.push({
      ref: d.ref,
      data: {
        folderId: intoId,
        ...(productChanged ? { productName: target || FieldValue.delete(), [RELEARN_PENDING_FIELD]: true } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
    })
  }
  await commitUpdatesInChunks(db, updates)
  for (const id of relearn) invalidateSourceProductCache(id)

  // 留下那一組的名字當正式名，舊組名收成它的別名（客人照舊那樣叫也認得；太短的不收）
  const intoName = String(into.name ?? '')
  const fromName = String(from.name ?? '')
  await makeGroupNameCanonical(db, workspaceId, intoName, intoId)
  let aliasFrom = ''
  if (fromName && !sameProductGroupName(fromName, intoName) && isUsableAlias(fromName)) {
    await confirmAlias(db, workspaceId, intoName, fromName)
    aliasFrom = fromName
  }
  // 現在是空的了（剛剛那一批之後才放進來的不算：⛔ 不要再查一次就刪——查完到刪之間又放進來的會掉回未分類）
  await db.collection(KNOWLEDGE_FOLDERS_COLLECTION).doc(fromId).delete()
  invalidateWorkspaceProductNames(workspaceId)
  invalidateProductAliases(workspaceId)
  return { moved: snap.size, relearnSourceIds: relearn, aliasFrom, fromName, intoName }
}
