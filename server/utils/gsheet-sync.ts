/**
 * Google Sheet「一列一卡」自動同步：重讀整張表 → 用標題當 key 比對既有卡 →
 * 新增 / 更新 / 刪除。Sheet 是商家自己的結構化表格，title / content 程式直接對應，
 * 不丟 LLM 切卡（結果穩定、無 diff 抖動）。
 *
 * questions（客人問法）例外：由 LLM 對「新增 / 內容有變」的卡補上（只補不改——
 * 不動 title / content，所以比對基準不受影響；沒動的卡沿用舊問法，平常同步零 LLM）。
 *
 * 安全保護：被「人工編輯過」(manuallyEditedAt) 的卡一律保留，不被 Sheet 覆蓋 / 刪除。
 */
import { createHash } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { enrichCardsWithLlm } from './ai-knowledge-chunker'
import { regenerateOverviewCard } from './ai-overview'
import {
  buildChunkSoftDeletePatch,
  createKnowledgeChunk,
  KNOWLEDGE_CHUNKS_COLLECTION,
  updateKnowledgeChunk,
} from './ai-knowledge-chunks'
import { chunkCountsTowardQuota, getKnowledgeChunkQuota, invalidateKnowledgeChunkCount } from './ai-knowledge-quota'
import { recordAiUsage } from './ai-usage'
import { callsOf, usageFromCalls } from './ai-usage-calls'
import {
  countSourceChunks,
  KNOWLEDGE_SOURCES_COLLECTION,
  listChunksBySource,
} from './ai-knowledge-sources'
import { normTitle, parseGoogleSheetUrl, readGoogleSheetAsCards, type ParsedSheetRef, type SheetCard } from './google-sheets'
import { knowledgeTitleKey } from '~~/shared/knowledge-title-key'
import { diffSheetCardFields, type SheetFieldChange } from '~~/shared/sheet-stale'
import { recordStaleSheetModules } from './sheet-stale-modules'
import { syncSheetProducts } from './sheet-products'
import { ensureSheetProductTags } from './sheet-catalog'
import type { KnowledgeSourceDoc } from '~~/shared/types/ai-knowledge'

export interface GsheetSyncResult {
  /**
   * `source_deleted`（`C-308`③）：同步做到一半，這份資料被刪掉了。這一輪建的已經收掉，
   * 呼叫端 ⛔ 不要再寫這份資料（寫不進去，也不該記成「同步成功」）。
   */
  outcome: 'unchanged' | 'synced' | 'blocked_mass_deletion' | 'source_deleted'
  added: number
  updated: number
  deleted: number
  kept: number
  /** outcome='blocked_mass_deletion' 時：這次會被刪掉的卡數（給確認文案用） */
  pendingDeletes?: number
  /**
   * kept 裡「因手動編輯而被鎖住」的張數（C-44）：表格改了但卡片不會跟——
   * 這是唯一會讓表格與卡片永久分歧的路，必須讓店家看得見（toast + 來源頁常駐提示），
   * 不能只有卡片上一顆沒解釋的小鎖 icon。
   */
  manualKept?: number
  /**
   * 表上有、但這個帳號的知識量額度滿了、所以**沒有新增**的列數（`C-296` 審查）。
   * 0 或沒有這格＝都收了。來源文件同步寫 `quotaSkippedCount`，來源頁要常駐講出來——
   * 不講的話，店家以為表上每一列都進了知識庫。
   */
  quotaSkipped?: number
  /**
   * 表上有、但店家在知識庫刪掉過（`gsheetExcludedTitles`）所以這次**跳過**的列數（`D-125`②）。
   * 不算新增、不算刪除、也不算「空間不夠沒收」——那是他自己的決定，來源頁另外講。
   */
  excludedSkipped?: number
}

/**
 * 同步結果寫成操作紀錄的那一句（`C-308`⑥）：手按「立即同步」跟排程自動同步講同一套話，
 * 不然同一份試算表的紀錄一筆講「張」一筆講「條」、一筆有講沒收的列一筆沒講。
 * ⛔ manualKept／quotaSkipped 都是「表上有、知識庫沒跟上」，不可以省略。
 */
export function gsheetSyncAuditNote(name: string, r: GsheetSyncResult): string {
  return `${name}：新增 ${r.added}、更新 ${r.updated}、刪除 ${r.deleted}`
    + (r.manualKept ? `；有 ${r.manualKept} 條因為在後台改過，沒有跟著表格更新` : '')
    + (r.quotaSkipped ? `；有 ${r.quotaSkipped} 列因為 AI 知識量滿了沒有新增` : '')
    + (r.excludedSkipped ? `；有 ${r.excludedSkipped} 列你在後台刪掉過，照你的意思沒有再收` : '')
}

/**
 * 這份資料還在不在（`C-308`③）。'gone'＝文件沒了（整份刪掉）；'recycled'＝還在但進了回收桶。
 * 讀失敗就讓它丟出去：不知道的時候寧可這一輪不做（下一輪重來），也不要猜「還在」而繼續建。
 */
async function sourceState(db: Firestore, workspaceId: string, sourceId: string): Promise<'live' | 'gone' | 'recycled'> {
  const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).get()
  if (!snap.exists) return 'gone'
  const d = snap.data() as { workspaceId?: string, isDeleted?: boolean, deletedAt?: unknown } | undefined
  if (d?.workspaceId !== workspaceId) return 'gone'
  return d?.isDeleted === true || d?.deletedAt != null ? 'recycled' : 'live'
}

/**
 * 資料在同步途中被刪掉了：把這一輪建的真刪掉（`C-308`③）。
 * 整份文件都不在了（'gone'）時，底下還掛著的也一起收——刪除那一邊在我們建卡之前就數完名單，
 * 名單之後才建的就是「AI 會用、後台看不到、刪不掉」的孤兒（2026-10-13 正式站測試撞到 9 條）。
 * 只是進回收桶（'recycled'）的不掃：那份資料還救得回來，底下的知識要跟著留著。
 */
async function discardRunWrites(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  createdIds: string[],
  state: 'gone' | 'recycled',
): Promise<void> {
  const refs = new Map(createdIds.map(id => [id, db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id)]))
  if (state === 'gone') {
    const left = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .where('sourceId', '==', sourceId)
      .get()
    for (const d of left.docs) refs.set(d.id, d.ref)
  }
  const all = [...refs.values()]
  for (let i = 0; i < all.length; i += 400) {
    const batch = db.batch()
    for (const ref of all.slice(i, i + 400)) batch.delete(ref)
    await batch.commit()
  }
  invalidateKnowledgeChunkCount(workspaceId)
  console.warn(`[gsheet-sync] ${sourceId} 同步途中資料被刪了，收掉 ${all.length} 條（這一輪建的 ${createdIds.length} 條）`)
}

const SOURCE_DELETED_RESULT: GsheetSyncResult = { outcome: 'source_deleted', added: 0, updated: 0, deleted: 0, kept: 0 }

/**
 * `C-436`：勾進目錄的商品要有標籤（客人點了才貼得上、推播才挑得到人）；只有這份表有目錄在用才建，失敗不擋同步。
 * `C-438` code review：⛔ 不能只在「這一輪有變動」才補——第一份商品清單（沒有變動紀錄）、上一輪寫標籤失敗的，都要靠每次同步補上。
 * 沒有要補的時候只多讀一筆商品清單。
 */
async function topUpSheetProductTags(db: Firestore, workspaceId: string, sourceId: string): Promise<void> {
  await ensureSheetProductTags(db, workspaceId, sourceId)
    .catch(e => console.warn('[gsheet-sync] 商品標籤沒建好（下次同步或存模組再補）：', sourceId, e))
}

/**
 * 大量刪除守門（純函式好測）：表格一次少掉太多列，多半是誤刪 / 篩選後全選刪 /
 * 分頁讀取異常，不是真的要下架——擋下來交人工確認（手動同步可帶 allowMassDeletion 放行）。
 * 門檻對齊自動套用的既有取捨：小來源（<4 卡）不吃比例規則（刪 2/3 張多半是真意圖、
 * 損害也小）；大來源 >30% 或絕對張數 >10 就擋。
 */
export function shouldBlockSheetDeletion(existingCount: number, deleteCount: number): boolean {
  if (deleteCount <= 0) return false
  if (deleteCount > 10) return true
  if (existingCount >= 4 && deleteCount / existingCount > 0.3) return true
  return false
}

/**
 * 單次同步最多補問法的卡數。手動同步端點走 HTTP，補問法要壓在閘道逾時內：
 * 60 卡 = 4 批（enrichCardsWithLlm 並行）≈ 一波 LLM 呼叫的時間。
 * 典型同步只動幾列，很少撞到；撞到的卡照常建立/更新、只是沒問法（不擋同步）。
 */
export const ENRICH_SYNC_MAX = 60

/**
 * 整張表的內容指紋（與列順序無關；標題或內容變了就會變）。
 * ⚠️ 分隔字寫成跳脫字 \u0000／\u0001，**不可以**改成別的字：以前檔案裡是直接打的 NUL／0x01 位元組
 *    （git 因此把整個檔案當二進位），跳脫字算出來的字串一模一樣；換成別的分隔字＝每一份試算表的指紋都變，
 *    下一輪同步全部重算一次（測試裡釘了一組改前算出來的指紋）。
 */
function cardsHash(cards: SheetCard[]): string {
  const norm = cards.map(c => `${c.title}\u0000${c.content}${controlsPart(c.controls)}`).sort().join('\u0001')
  return createHash('sha256').update(norm).digest('hex')
}

/**
 * 開關欄（`C-434`：「放進LINE目錄」）不在卡片內文裡，但勾了／取消也要算「表格變了」，
 * 不然只改勾勾的那一小時會被當成沒變、商品目錄不會跟。
 * ⛔ 只在這一列有開關值的時候才加：沒有開關欄的表（現在所有的表）指紋一個字都不能變（見上面的說明）。
 */
function controlsPart(controls: SheetCard['controls']): string {
  if (!controls) return ''
  return `\u0002${Object.keys(controls).sort().map(k => `${k}=${controls[k]}`).join('\u0003')}`
}

/**
 * 這個帳號還能再新增幾條知識（跟匯入、手寫卡用同一套數法：getKnowledgeChunkQuota，回收桶與草稿不算）。
 * null＝不限：方案不限張數，或讀不到方案——讀不到時照 assertKnowledgeChunkQuota 的規矩放行（fail-open），
 * 同步不因為讀帳單失敗就停下來。
 */
async function remainingKnowledgeRoom(db: Firestore, workspaceId: string): Promise<number | null> {
  const quota = await getKnowledgeChunkQuota(workspaceId, db).catch(() => null)
  if (!quota || quota.limit == null) return null
  return Math.max(0, quota.limit - quota.used)
}

/**
 * 同步一個 gsheet 來源。內容指紋沒變 → 只更新 lastFetchedAt（outcome=unchanged）。
 * 變了 → 套用新增/更新/刪除並更新 contentHash / chunkCount。
 *
 * 知識量額度（`C-296` 審查）：匯入可以「先收放得下的前 N 條」，那樣建出來的來源 contentHash 是空的，
 * 第一輪同步就會把沒收的列全部建出來——而這支以前完全不看額度，等於繞過方案上限。現在：
 * - 新增最多建到額度滿為止（照表上的順序），其餘記成 quotaSkipped／來源的 quotaSkippedCount；
 *   更新、刪除照常（刪除先做，這一輪刪掉的卡空出來的位置可以給新的列用）。
 * - 不限張數的方案跟以前完全一樣。
 * - 上次有少收（quotaSkippedCount > 0）時，「指紋沒變就跳過」不能直接跳：額度可能空出來了（刪了卡、升級）。
 *   先看還有沒有位置——還是滿的就照樣當「沒變」（不重讀卡片、不寫紀錄、不重做總覽），有位置才整份比對一次。
 *
 * 在後台刪掉的列（`D-125`②，`gsheetExcludedTitles`）：跳過——不建、不算刪除、不算空間不夠沒收，記成 excludedSkipped。
 *
 * 跟刪除撞車（`C-308`③）：同步要跑補問法（LLM，十幾秒），這段時間他可能把這份資料刪了。以前照樣一條條建下去，
 * 建出來的知識不屬於任何一份資料——AI 會用、後台看不到也刪不掉。現在寫入前、每建一條前、寫完都確認資料還在；
 * 不在了就停、把這一輪建的收掉，回 `source_deleted`（⛔ 不再寫這份資料、也不丟錯）。
 */
export async function syncGoogleSheetSource(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  data: Pick<KnowledgeSourceDoc, 'url' | 'gsheetId' | 'gsheetGid' | 'contentHash' | 'gsheetTabRule' | 'quotaSkippedCount' | 'gsheetExcludedTitles' | 'blockedPendingDeletes'>
    & Partial<Pick<KnowledgeSourceDoc, 'name' | 'gsheetFieldHeaders'>> & { generateOverview?: boolean },
  opts: { allowMassDeletion?: boolean } = {},
): Promise<GsheetSyncResult> {
  const ref: ParsedSheetRef | null = data.gsheetId
    ? { spreadsheetId: data.gsheetId, gid: data.gsheetGid ?? null }
    : parseGoogleSheetUrl(String(data.url || ''))
  if (!ref) throw createError({ statusCode: 400, statusMessage: '這份資料沒有有效的 Google 試算表連結' })
  const excludedKeys = new Set((data.gsheetExcludedTitles ?? []).map(t => knowledgeTitleKey(String(t))).filter(Boolean))

  // 讀法要跟「當初匯入時」同一套（`C-296`）：2026-10-10 之前建的來源沒有 gsheetTabRule，
  // 分頁與每一列都照舊讀——⛔ 不可以替它換新規則，下一輪同步就會把別頁的列整批變成卡、
  // 或把第一題當成欄位名稱刪掉，店家什麼都沒做。
  const sheet = await readGoogleSheetAsCards(ref, undefined, { legacy: data.gsheetTabRule !== 'all' })
  const newHash = cardsHash(sheet.cards)
  const prevQuotaSkipped = Math.max(0, Math.floor(Number(data.quotaSkippedCount ?? 0)) || 0)

  // 沒變：只戳 lastFetchedAt。上次有因為額度少收的，要先確認額度還是滿的才算「沒變」
  if (data.contentHash && data.contentHash === newHash) {
    const room = prevQuotaSkipped > 0 ? await remainingKnowledgeRoom(db, workspaceId) : 0
    if (prevQuotaSkipped === 0 || (room !== null && room <= 0)) {
      try {
        await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
          lastFetchedAt: FieldValue.serverTimestamp(),
          // `C-423`：欄名也記（機器人模組從卡片切「某一格」只認這份）；內容沒變也寫，上線前建的來源靠這裡補上
          gsheetFieldHeaders: sheet.fieldHeaders,
          // 上次被排程擋下（表格一次少太多列），這次表格又跟卡片對得上了＝沒有要確認的刪除（`C-308`⑤）
          ...(Number(data.blockedPendingDeletes ?? 0) > 0 ? { blockedPendingDeletes: 0 } : {}),
        })
      }
      catch (e) {
        // 讀表的那幾秒資料被刪了：不是同步失敗，照實回報
        if ((await sourceState(db, workspaceId, sourceId).catch(() => 'live')) !== 'live') return { ...SOURCE_DELETED_RESULT }
        throw e
      }
      const excludedOnSheet = new Set(sheet.cards.map(c => knowledgeTitleKey(c.title)).filter(k => excludedKeys.has(k))).size
      // `C-434`：表沒變也跑一次（讀一筆、沒變不寫）——上線前就在同步的表，第一份商品清單靠這裡建
      const unchangedProducts = await syncSheetProducts(db, workspaceId, sourceId, sheet)
      if (unchangedProducts !== null) await topUpSheetProductTags(db, workspaceId, sourceId)
      return {
        outcome: 'unchanged',
        added: 0,
        updated: 0,
        deleted: 0,
        kept: Math.max(0, sheet.cards.length - prevQuotaSkipped - excludedOnSheet),
        ...(prevQuotaSkipped > 0 ? { quotaSkipped: prevQuotaSkipped } : {}),
        ...(excludedOnSheet > 0 ? { excludedSkipped: excludedOnSheet } : {}),
      }
    }
  }

  // 變了：用標題 key 比對既有卡（排除總覽卡）
  const existing = await listChunksBySource(db, workspaceId, sourceId)
  const existingByTitle = new Map<string, (typeof existing)[number]>()
  for (const c of existing) {
    if (!c.isOverview) existingByTitle.set(normTitle(c.title), c)
  }

  // ── pass 1：先分類、不寫入 —— 把「新增 + 內容有變」的卡集中起來一次補問法 ──
  const seen = new Set<string>()
  const toCreate: SheetCard[] = []
  const toUpdate: Array<{ oldId: string; card: SheetCard }> = []
  const fieldChanges: SheetFieldChange[] = []
  let added = 0
  let updated = 0
  let kept = 0
  let deleted = 0
  let manualKept = 0
  let excludedSkipped = 0

  for (const card of sheet.cards) {
    const key = normTitle(card.title)
    if (seen.has(key)) continue // 表內標題重複 → 只認第一列
    seen.add(key)
    const old = existingByTitle.get(key)

    if (!old && excludedKeys.has(knowledgeTitleKey(card.title))) {
      // 他在後台刪掉過這一列（`D-125`②）：照他的意思不再收。⚠️ 已經在 seen 裡，下面不會被當成「表上少了」
      excludedSkipped++
    }
    else if (!old) {
      toCreate.push(card)
    }
    else if (old.manuallyEditedAtMs > 0) {
      kept++ // 人工編輯過：尊重人工版本，不覆蓋
      // 表格版與卡片版不同才算「被鎖住的分歧」；相同的手編卡沒有分歧不用提醒
      if (old.content !== card.content || old.title !== card.title) manualKept++
    }
    else if (old.content !== card.content || old.title !== card.title) {
      toUpdate.push({ oldId: old.id, card })
      // `C-429`：哪幾格變了（改之前照上一次記的欄名切）
      fieldChanges.push(...diffSheetCardFields(card.title, old.content, card.content, data.gsheetFieldHeaders, sheet.fieldHeaders))
    }
    else {
      kept++
    }
  }

  // ── 刪除也先分類、後守門：表上已不存在的舊卡（人工編輯過的保留） ──
  const toDelete: Array<{ id: string; status: string }> = []
  for (const [key, old] of existingByTitle) {
    if (seen.has(key)) continue
    if (old.manuallyEditedAtMs > 0) continue // 下面 kept++ 照舊在刪除迴圈計
    toDelete.push({ id: old.id, status: old.status })
  }
  // ⛔大量刪除守門：一次少太多列＝多半是誤刪/篩選後全選刪/分頁讀取異常。
  // 擋下時**什麼都不套用、contentHash 不前進**——半套半不套再推進指紋，
  // 下次同步會回報「沒變」，被擋下的刪除就永遠沒人再看（C-44 同款吞變動病）。
  if (!opts.allowMassDeletion && shouldBlockSheetDeletion(existingByTitle.size, toDelete.length)) {
    return {
      outcome: 'blocked_mass_deletion',
      added: 0,
      updated: 0,
      deleted: 0,
      kept: existing.length,
      pendingDeletes: toDelete.length,
    }
  }

  // ── 知識量額度：新增最多建到滿（照表上的順序）。只在真的有新列時才去數（平常同步不多讀） ──
  // 這一輪要進回收桶的舊卡會空出位置（回收桶不算額度），所以算進去、下面也先刪再建。
  let quotaSkipped = 0
  if (toCreate.length) {
    const room = await remainingKnowledgeRoom(db, workspaceId)
    if (room !== null) {
      // 只有算額度的卡刪了才空得出位置（草稿本來就沒算，見 chunkCountsTowardQuota）
      const fits = room + toDelete.filter(d => chunkCountsTowardQuota(d)).length
      if (toCreate.length > fits) quotaSkipped = toCreate.splice(fits).length
    }
  }

  // ── 補問法（只補不改）：一列一卡沒有 questions，questions 進 embedding 是檢索
  // 命中的關鍵。只對「新增 + 內容有變」的卡跑；沒動的卡沿用舊問法 → 平常同步零 LLM。
  // 失敗不擋同步（enrichCardsWithLlm 內部逐批降級成空陣列）。
  // 額度擋下沒建的列不在 toCreate 裡了，不替它們花錢補問法。
  const enrichTargets = [...toCreate, ...toUpdate.map(u => u.card)]
  const enrichable = enrichTargets.slice(0, ENRICH_SYNC_MAX)
  if (enrichTargets.length > enrichable.length) {
    console.warn(`[gsheet-sync] ${sourceId}: 本次變動 ${enrichTargets.length} 卡，僅前 ${ENRICH_SYNC_MAX} 卡補問法（其餘照常同步、暫無問法）`)
  }
  const enriched = enrichable.length
    ? await enrichCardsWithLlm(enrichable.map(c => ({ title: c.title, content: c.content })))
    : { items: [], inputTokens: 0, outputTokens: 0 }
  if (enriched.inputTokens || enriched.outputTokens) {
    // 補問法 token 照實入帳（月度 quota + import 分項；照實際模型算、JSON 壞掉那批也算）；記帳失敗不擋同步
    await recordAiUsage(workspaceId, usageFromCalls('build', callsOf(enriched)))
  }

  // ── pass 2：套用。⛔ 先確認資料還在（`C-308`③）：上面補問法要十幾秒，這段時間他可能把這份刪了 ──
  // 這一輪建的知識 id 都記下來：中途發現資料沒了，要把它們收掉（不然就是看不到、刪不掉、AI 卻會用的孤兒）
  const createdIds: string[] = []
  const before = await sourceState(db, workspaceId, sourceId)
  if (before !== 'live') {
    await discardRunWrites(db, workspaceId, sourceId, createdIds, before)
    return { ...SOURCE_DELETED_RESULT }
  }

  try {
    // 先刪：這一輪刪掉的卡空出來的額度，上面已經算給新增的列用了
    // 新表已不存在的舊卡 → 進回收桶（軟刪除，30 天內可還原）；人工編輯過的保留
    // ⚠️ 這裡是「表格少了那一列」的決定，⛔ 不寫進 gsheetExcludedTitles（那只收他在後台刪的，`D-125`②）
    for (const [key, old] of existingByTitle) {
      if (seen.has(key)) continue
      if (old.manuallyEditedAtMs > 0) {
        kept++
        manualKept++ // 表上已刪、卡片被鎖住留著＝分歧
        continue
      }
      await db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(old.id)
        .update(buildChunkSoftDeletePatch(old.status))
      deleted++
    }

    // enriched.items 與 enrichTargets 同序：先 create 後 update
    for (let i = 0; i < toCreate.length; i++) {
      // 每建一條前再確認一次：刪除那一邊是先數名單再刪，名單數完之後才建的不會被收到
      const state = await sourceState(db, workspaceId, sourceId)
      if (state !== 'live') {
        await discardRunWrites(db, workspaceId, sourceId, createdIds, state)
        return { ...SOURCE_DELETED_RESULT }
      }
      const card = toCreate[i]!
      const extra = enriched.items[i]
      const chunkId = uuidv4()
      createdIds.push(chunkId) // 先記再建：建到一半丟錯，收的時候也收得到
      await createKnowledgeChunk(db, {
        workspaceId,
        chunkId,
        title: card.title,
        content: card.content,
        tags: extra?.tags.length ? extra.tags : card.tags,
        questions: extra?.questions ?? [],
        sourceId,
      })
      added++
    }
    for (let j = 0; j < toUpdate.length; j++) {
      const { oldId, card } = toUpdate[j]!
      const extra = enriched.items[toCreate.length + j]
      await updateKnowledgeChunk(db, {
        chunkId: oldId,
        title: card.title,
        content: card.content,
        // tags：沒補到就傳 undefined → updateKnowledgeChunk 保留舊標籤（一列一卡的 card.tags 永遠是 []，直接帶會清空）。
        tags: extra?.tags.length ? extra.tags : undefined,
        // questions：內容已變 → 舊問法是照「舊答案」生的、已過時。有補到就用新的；沒補到就清空（傳 []），
        // 別讓過時問法跟新內容一起進 embedding（避免矛盾拉低命中）；空缺由 reenrich 回填程序補上。
        questions: extra?.questions.length ? extra.questions : [],
        contentChanged: true,
        manualEdit: false,
      })
      updated++
    }
  }
  catch (e) {
    // 寫到一半出錯：多半是資料（連同底下的知識）剛被刪掉，改到的那一條已經不在了。是的話照「被刪了」收尾
    const state = await sourceState(db, workspaceId, sourceId).catch(() => 'live' as const)
    if (state !== 'live') {
      await discardRunWrites(db, workspaceId, sourceId, createdIds, state)
      return { ...SOURCE_DELETED_RESULT }
    }
    throw e
  }
  // 張數變了：額度快取（60 秒）要重數，不然接著匯入／手寫卡會拿到舊的張數
  if (added || deleted) invalidateKnowledgeChunkCount(workspaceId)

  // 寫完再查一次：最後一條建的同時被刪掉，上面的檢查看不到
  const after = await sourceState(db, workspaceId, sourceId)
  if (after !== 'live') {
    await discardRunWrites(db, workspaceId, sourceId, createdIds, after)
    return { ...SOURCE_DELETED_RESULT }
  }

  const chunkCount = await countSourceChunks(db, workspaceId, sourceId)
  try {
    await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
      contentHash: newHash,
      chunkCount,
      lastFetchedAt: FieldValue.serverTimestamp(),
      gsheetFieldHeaders: sheet.fieldHeaders,
      updatedAt: FieldValue.serverTimestamp(),
      outdatedAt: null,
      // C-44：被手動編輯鎖住、與表格分歧的條數。來源頁用它常駐提示
      // 「N 條不會跟表格更新」；0 也要寫（分歧解掉後提示要消失）。
      manualKeptCount: manualKept,
      // 額度滿了沒新增的列數；0 也要寫（空出位置收完之後提示要消失）。
      // 指紋照樣前進：還有少收的時候，上面「沒變就跳過」會先看額度，不會把這幾列藏起來。
      quotaSkippedCount: quotaSkipped,
      // 同步成功＝沒有等著確認的大量刪除了（`C-308`⑤；手按「立即同步」放行也走這裡）
      blockedPendingDeletes: 0,
      // 「這份在講什麼」（`C-316`）：表格真的有增刪改才作廢，下次打開時照新內容重整理（/code-review 第 4 條）
      ...(added || updated || deleted ? { summary: [], summaryAt: null } : {}),
    })
  }
  catch (e) {
    const state = await sourceState(db, workspaceId, sourceId).catch(() => 'live' as const)
    if (state !== 'live') {
      await discardRunWrites(db, workspaceId, sourceId, createdIds, state)
      return { ...SOURCE_DELETED_RESULT }
    }
    throw e
  }

  // 型錄型 gsheet 的總覽卡跟著增刪改重生（C-49C）：原本永遠停在第一次匯入的版本。
  // 失敗不擋同步（總覽是加分項）；沒動卡就不重生（白花一次 LLM）。
  if (data.generateOverview === true && (added || updated || deleted)) {
    await regenerateOverviewCard(db, workspaceId, sourceId)
      .catch(e => console.warn('[gsheet-sync] overview regen failed:', e))
    // 總覽也要跑一次 LLM：這段時間被刪掉的話，剛建的總覽同樣會變成孤兒——整份不在了就連它一起收
    const afterOverview = await sourceState(db, workspaceId, sourceId).catch(() => 'live' as const)
    if (afterOverview === 'gone') {
      await discardRunWrites(db, workspaceId, sourceId, createdIds, afterOverview)
      return { ...SOURCE_DELETED_RESULT }
    }
  }

  // `C-429`：改了的那幾格，找出還寫著改之前原字的機器人模組（首頁提醒＋模組頁一鍵換成同步）。
  // 只有真的有列內容變了才讀模組；記不下來不擋同步（裡面自己吞錯）
  if (fieldChanges.length) {
    await recordStaleSheetModules(db, workspaceId, sourceId, String(data.name ?? ''), fieldChanges)
  }

  // `C-434`：哪一列是哪個商品、誰改了名、誰勾進目錄（商品目錄、範本、模組裡「試算表的一格」都靠它）。失敗不擋同步
  const productChanges = await syncSheetProducts(db, workspaceId, sourceId, sheet)
  if (productChanges !== null) await topUpSheetProductTags(db, workspaceId, sourceId)

  return {
    outcome: 'synced',
    added,
    updated,
    deleted,
    kept,
    manualKept,
    quotaSkipped,
    ...(excludedSkipped ? { excludedSkipped } : {}),
  }
}
