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
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
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
import { recordAiUsage } from './ai-usage'
import { writeAuditLog } from './audit-log'
import { productNameForGroup } from '~~/shared/knowledge-product-group'
import type { KnowledgeFolderDoc } from '~~/shared/types/ai-knowledge'

/** 與 reindex / bulk-create 一致的保守併發 */
const EMBED_CONCURRENCY = 5

export interface SourceRelearnResult {
  total: number
  /** 停用的、沒內容的跳過（重新學習不偷偷把停用的打開） */
  skipped: number
  indexed: number
  failed: number
  failures: Array<{ id: string; status: string; failureReason?: string }>
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

  const results: SourceRelearnResult['failures'] = new Array(docs.length)
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
      results[idx] = { id: r.id, status: r.status, failureReason: r.failureReason }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, docs.length) }, worker))
  if (embeddingTokens > 0) await recordAiUsage(workspaceId, { buildEmbeddingTokens: embeddingTokens }, db)

  const failures = results.filter(r => r.status === 'failed')
  return {
    total: snap.size,
    skipped: snap.size - docs.length,
    indexed: results.length - failures.length,
    failed: failures.length,
    failures,
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
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) return { changed: false, productName: '', notFound: true }
  const group = await readGroup(db, workspaceId, source.data.folderId)
  const target = productNameForGroup(group, {
    isCatalog: source.data.generateOverview === true,
    isSheet: source.data.type === 'gsheet',
  })
  const previous = String(source.data.productName ?? '').trim()
  if (previous === target) return { changed: false, productName: target }

  // 跟以前「AI 認的商品名」存檔同一條路：updateSourceSettings 存名字（也會清快取），再重新學習
  const updated = await updateSourceSettings(db, workspaceId, sourceId, { productName: target })
  if (!updated) return { changed: false, productName: '', notFound: true }
  const relearned = await relearnSourceChunks(db, workspaceId, sourceId)

  // 稽核（`C-254`）：商品名換掉＝整份資料歸屬的商品換了（答錯台的老毛病），⛔ 失敗條數一定要一起記
  await writeAuditLog({
    workspaceId,
    uid: ctx.uid,
    actor: ctx.actor ?? 'human',
    action: 'source.put',
    targetId: sourceId,
    before: { productName: previous },
    after: { productName: target, chunkIdsCount: relearned.indexed, failedItemsCount: relearned.failed },
    note: `${String(source.data.name ?? '')}：`
      + (target ? `放進「${group?.name ?? ''}」，AI 把它當成「${target}」的資料` : `不在商品分組裡，AI 不再把它當成「${previous}」的資料`)
      + `，重新學習 ${relearned.indexed} 條${relearned.failed ? `、失敗 ${relearned.failed} 條` : ''}`,
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
  const batch = db.batch()
  for (const d of snap.docs) {
    const s = d.data() as { productName?: string; generateOverview?: boolean; type?: string }
    const target = productNameForGroup(group, { isCatalog: s.generateOverview === true, isSheet: s.type === 'gsheet' })
    if (String(s.productName ?? '').trim() === target) continue
    batch.update(d.ref, { productName: target || FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() })
    changed.push(d.id)
  }
  if (!changed.length) return []
  await batch.commit()
  for (const id of changed) invalidateSourceProductCache(id)
  invalidateWorkspaceProductNames(workspaceId)
  const name = productNameForGroup(group)
  if (name) await addWorkspaceProductName(db, workspaceId, name)
  return changed
}
