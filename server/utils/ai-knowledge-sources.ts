/**
 * knowledgeSources 服務層：CRUD + 簡單列表查詢。
 *
 * Source = 「匯入的來源」（PDF / 網址 / 手打）。每個 source 自動切出多張 chunk，
 * chunk.sourceId 指回 source.id。手打單卡（type='manual'）也可有 source 把它們群組起來。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import {
  addWorkspaceProductName,
  buildChunkSoftDeletePatch,
  invalidateSourceProductCache,
  invalidateTagIndexCache,
  KNOWLEDGE_CHUNKS_COLLECTION,
} from './ai-knowledge-chunks'
import type {
  KnowledgeSourceDoc,
  KnowledgeSourceStatus,
  KnowledgeSourceType,
} from '~~/shared/types/ai-knowledge'
import { NUMERIC_DRIFT_LEARN_ROUNDS } from '~~/shared/knowledge-fingerprint'
// ⚠️ 這支會繞一圈 import 回本檔（folder-guard → ai-knowledge-folders → 本檔）。安全的前提是
//    兩邊都只在函式裡用對方的東西、頂層不讀——動這三支檔案的頂層時要記得這個圈。
import { resolveKnowledgeFolderId } from './ai-knowledge-folder-guard'
import { deleteSourceFiles } from './knowledge-source-files'

export const KNOWLEDGE_SOURCES_COLLECTION = 'knowledgeSources'

// ── Catalog source ids cache ──────────────────────────────────────
// 「型錄/列表來源」(generateOverview=true) 旗下有很多*不同產品*共用同一個 sourceId。
// 答題時 dedupeBySource 不該把它們當「同主題」併掉，所以需要快速查出哪些 sourceId 是型錄。
// 小量資料 + 答題熱路徑，快取 60s 避免每次答題多打 Firestore。
const CATALOG_SRC_TTL_MS = 60_000
const catalogSrcCache = new Map<string, { expiresAt: number; ids: Set<string> }>()

export function invalidateCatalogSourceCache(workspaceId: string) {
  catalogSrcCache.delete(workspaceId)
}

/**
 * 回傳此 workspace 中「型錄/列表來源」(generateOverview=true) 的 sourceId 集合。
 * 通用——只看 generateOverview 旗標，不綁任何特定站台/租戶。
 */
export async function getCatalogSourceIds(
  db: Firestore,
  workspaceId: string,
): Promise<Set<string>> {
  const cached = catalogSrcCache.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.ids

  const ids = new Set<string>()
  try {
    // 只用 workspaceId 過濾（單欄位、免複合索引），generateOverview 在程式端篩。
    // 加上限：型錄來源本來就少，避免在答題熱路徑做無上限讀取。
    const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .limit(200)
      .get()
    for (const d of snap.docs) {
      if (d.data()?.generateOverview === true) ids.add(d.id)
    }
  }
  catch (e) {
    // 查詢失敗（缺 index 等）不擋答題：回空集合 = 維持舊行為（全部 dedupe）
    console.warn('[ai-knowledge-sources] getCatalogSourceIds failed:', e)
  }
  catalogSrcCache.set(workspaceId, { expiresAt: Date.now() + CATALOG_SRC_TTL_MS, ids })
  return ids
}

export interface SourceSummary {
  id: string
  type: KnowledgeSourceType
  name: string
  url: string
  /** 所屬資料夾；null = 未分類 */
  folderId: string | null
  status: KnowledgeSourceStatus
  failureReason?: string
  chunkCount: number
  refreshIntervalMinutes: number
  onChangeBehavior: 'notify' | 'log_only'
  /** 所屬產品的正規名稱；'' = 非單一產品來源。改動後要重建該來源索引才生效。 */
  productName: string
  /**
   * 型錄／列表來源（旗下本來就是很多不同產品）。
   * 列表 UI 要靠它跟體檢用同一把尺判斷「這份該不該設產品名」——
   * 少了它，畫面會把型錄標成「未設產品」，體檢卻不算它，兩邊說法不一致。
   */
  generateOverview: boolean
  /** type='url'：是否允許小幅文字變動自動套用（預設 true） */
  urlAutoApply: boolean
  lastFetchedAtMs: number
  outdatedAtMs: number
  updatedAtMs: number
  /**
   * type='url'：這個網址的數字（金額／人數／倒數之類）每次抓都在變，系統已學會忽略它們，
   * 只在文字內容改變時才提醒。要在資料頁講出來——不講的話，店家會以為改價也會通知。
   */
  numbersVolatile: boolean
  /**
   * type='url'：連續多輪抓到的內容都不一樣，自動偵測判斷不出哪一版才算數（0 = 正常）。
   * 這是第三種狀態，不能跟「一切正常」混為一談。
   */
  detectStalledAtMs: number
  /**
   * type='gsheet'：上次同步時「因手動編輯被鎖住、與表格內容分歧」的張數（C-44）。
   * >0 代表商家改了表格但那幾張卡不會跟——要在來源頁常駐講出來，不能只有小鎖 icon。
   */
  manualKeptCount: number
  /**
   * type='gsheet'：上次同步時「表格上有、但知識空間滿了沒新增」的列數（`C-296`）。
   * >0 也要在來源頁常駐講：店家在表格加了一列、AI 卻答不出來，原因只在這裡。
   */
  quotaSkippedCount: number
  /**
   * type='gsheet'：店家在知識庫刪掉、之後同步不再收的那幾列（`D-125`②）。顯示用的原標題；沒有＝[]。
   * 來源頁要講出來（「有 N 列你在後台刪掉了，不會再收」），並給一顆「重新收回來」（PUT clearExcludedRows）。
   */
  gsheetExcludedTitles: string[]
  /**
   * type='gsheet'：排程因為「表格一次少太多列」停下來、等他確認的刪除列數（`C-308`⑤）；0＝沒有擋下。
   * >0 時畫面要講「按立即同步確認」，⛔ 不是「把表分享給服務帳號」（那是讀不到表的時候才對）。
   */
  blockedPendingDeletes: number
  /**
   * type='file'：留著的原檔（`C-296`③）；null＝沒有（2026-10-10 以前匯入的、或留存失敗）。
   * ⛔ 不回 Storage 路徑：下載一律走 file-url 端點發短效網址。
   */
  originalFile: { name: string, size: number } | null
  /**
   * 「這份在講什麼」（`C-316`，D-126 點開一份資料的頁面）：最多 3 行、每行 30 字內，AI 從這份的條目整理的。
   * 還沒整理過＝[]；畫面打 PUT `{ generateSummary: true }` 才會產生（存在資料上，之後不再花錢）。
   */
  summary: string[]
  /** summary 是什麼時候整理的（ms）；0＝還沒整理過 */
  summaryAt: number
}

/** 資料文件上「這份在講什麼」那兩格（`C-316`）。共用型別沒有這兩格，只在這支讀寫，型別就留在這裡 */
type SourceDocWithSummary = Partial<KnowledgeSourceDoc> & { summary?: unknown, summaryAt?: unknown }

/** 摘要最多幾行（`C-316`）：畫面上「這份在講什麼」三行 */
export const SOURCE_SUMMARY_MAX_LINES = 3

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

/** 把 raw doc 轉成 UI 友善的 summary（時間戳轉 ms、有預設值） */
export function docToSourceSummary(id: string, raw: SourceDocWithSummary): SourceSummary {
  return {
    id,
    type: (raw.type ?? 'file') as KnowledgeSourceType,
    name: String(raw.name ?? ''),
    url: String(raw.url ?? ''),
    folderId: raw.folderId ?? null,
    status: (raw.status ?? 'ready') as KnowledgeSourceStatus,
    failureReason: raw.failureReason,
    chunkCount: Number(raw.chunkCount ?? 0),
    refreshIntervalMinutes: Number(raw.refreshIntervalMinutes ?? 0),
    onChangeBehavior: raw.onChangeBehavior === 'log_only' ? 'log_only' : 'notify',
    productName: String(raw.productName ?? '').trim(),
    generateOverview: raw.generateOverview === true,
    urlAutoApply: raw.urlAutoApply !== false,
    lastFetchedAtMs: tsToMs(raw.lastFetchedAt),
    outdatedAtMs: tsToMs(raw.outdatedAt),
    updatedAtMs: tsToMs(raw.updatedAt),
    // 從輪數推導，不另存布林值：兩個地方各存一份遲早會對不起來
    numbersVolatile: Number(raw.numericDriftRounds ?? 0) >= NUMERIC_DRIFT_LEARN_ROUNDS,
    detectStalledAtMs: tsToMs(raw.detectStalledAt),
    manualKeptCount: Number(raw.manualKeptCount ?? 0),
    quotaSkippedCount: Number(raw.quotaSkippedCount ?? 0),
    gsheetExcludedTitles: Array.isArray(raw.gsheetExcludedTitles)
      ? raw.gsheetExcludedTitles.map(String).filter(t => t.trim())
      : [],
    blockedPendingDeletes: Math.max(0, Number(raw.blockedPendingDeletes ?? 0) || 0),
    originalFile: raw.filePath
      ? { name: String(raw.fileName || raw.name || ''), size: Number(raw.fileSize ?? 0) }
      : null,
    summary: Array.isArray(raw.summary)
      ? raw.summary.map(s => String(s ?? '').trim()).filter(Boolean).slice(0, SOURCE_SUMMARY_MAX_LINES)
      : [],
    summaryAt: tsToMs(raw.summaryAt),
  }
}

export interface ListSourcesResult {
  items: SourceSummary[]
  /**
   * 主查詢掛掉、只靠備援湊出來的清單（`C-137`）。
   * true 代表**這份清單可能不完整**，呼叫端必須讓使用者看得到這件事——
   * 一份少了東西卻長得很正常的清單，比一個錯誤訊息危險得多。
   */
  degraded: boolean
  /**
   * 資料份數撞到 `limit`，後面的沒有回（`C-138`）。
   * 同一種病的第三種形狀：搜尋、回收桶、體檢撞上限時都會回報 `truncated`，
   * 只有這支預設 100 份、撞到默默切掉——超過 100 份資料的帳號會有東西永遠看不到，
   * 而且畫面完全正常。目前 MYFEEL 31 份還沒撞到，是「還沒中」不是「不會中」。
   */
  truncated: boolean
}

/**
 * 列出某 workspace 的所有 source（依 updatedAt 倒序）。
 */
export async function listSources(
  db: Firestore,
  workspaceId: string,
  limit = 100,
): Promise<ListSourcesResult> {
  /**
   * ⛔過濾要在查詢層做，不能「先 limit(100) 再用 JS 濾掉墓碑」（C-49E）：
   * 軟刪除會把 updatedAt 推到最新，墓碑因此排在 `orderBy('updatedAt','desc')` 的最前面——
   * 刪掉 40 張手寫卡就有 40 個墓碑佔滿視窗前段，濾完只剩 60 筆，真來源在畫面上消失 30 天。
   * 舊資料沒有 `isDeleted` 欄位 → 撈不到，所以多撈一輪「沒有這個欄位的舊 doc」補齊。
   *
   * 🔴 **2026-09-04 線上事故（`C-137`）**：`isDeleted == false` ＋ `orderBy updatedAt` 是
   * 兩個欄位的複合查詢，**需要一支複合索引**，而那支索引從來沒宣告、沒部署。
   * 於是主查詢在正式環境上一直是 `FAILED_PRECONDITION`，舊版的 `.catch(() => null)`
   * 把它整個吞掉不留一個字——結果是 **8/19 之後每一份透過匯入建立的來源都不在清單上**
   * （它們都帶 `isDeleted: false`，備援那一輪只認「沒有這個欄位」的舊 doc）。
   * 老闆的回報正是這個：「知識庫搜尋找得到，但是選單上找不到。」
   * ⛔ 這裡有兩條不可以再犯的規矩：
   *   ① 唯讀路徑的 catch **一定要出聲**（見記憶：catch+回空＝整類東西從畫面靜靜消失）
   *   ② 主查詢掛掉時，備援不可以「順便把新資料也濾掉」——降級要降在精度上，不是降在
   *      「看不看得見」上。所以失敗時改用 `isDeleted !== true` 的寬鬆判準把兩種資料都收進來，
   *      並回報 `degraded` 讓畫面說得出「這份清單可能不完整」。
   */
  let indexMissing = false
  const [freshSnap, legacySnap] = await Promise.all([
    db.collection(KNOWLEDGE_SOURCES_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .where('isDeleted', '==', false)
      .orderBy('updatedAt', 'desc')
      .limit(limit)
      .get()
      .catch((e) => {
        indexMissing = true
        console.warn('[ai-knowledge-sources] listSources 主查詢失敗，改用備援（清單可能不完整）：', e)
        return null
      }),
    db.collection(KNOWLEDGE_SOURCES_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .orderBy('updatedAt', 'desc')
      .limit(limit)
      .get(),
  ])
  const byId = new Map<string, any>()
  for (const d of freshSnap?.docs ?? []) byId.set(d.id, d.data())
  for (const d of legacySnap.docs) {
    const data = d.data() as any
    if (data?.deletedAt != null) continue
    // 正常時：只補「沒有 isDeleted 欄位」的舊 doc（新的那批由主查詢負責，已經在上面了）。
    // 降級時：主查詢什麼都沒回，這一輪要把新舊全部收下，否則新來源會整批消失。
    const isTombstone = data?.isDeleted === true
    const isLegacy = data?.isDeleted === undefined
    if (isTombstone) continue
    if (!indexMissing && !isLegacy) continue
    byId.set(d.id, data)
  }
  const merged = [...byId.entries()]
    .map(([id, data]) => docToSourceSummary(id, data))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
  return {
    items: merged.slice(0, limit),
    degraded: indexMissing,
    // 兩支查詢各自都撈滿了才算真的「還有更多」；合併後剛好等於 limit 也可能只是剛好
    truncated: merged.length > limit || legacySnap.size >= limit || (freshSnap?.size ?? 0) >= limit,
  }
}

export interface DuplicateSourceHit {
  id: string
  name: string
  type: KnowledgeSourceType
  chunkCount: number
  updatedAtMs: number
}

/**
 * 用內容指紋找「這份東西是不是已經匯進來過了」（`C-134`）。
 *
 * 為什麼要有這支：手動上傳從來沒有內容去重——同一份說明書重傳一次就是
 * OCR ＋ 切卡 ＋ embedding 整套重跑重收費，而且**畫面上多一份一模一樣的資料**。
 * 2026-09-04 在 MYFEEL 正式資料上看到同一本 Kieslect 說明書並存三份、45 張重複卡，
 * 三份的產品名還各寫各的（產品鎖認的是名字字串 → 對系統來說變成三個產品）。
 *
 * ⚠️ 只認**這次改動之後**匯入的資料：舊來源的 `appliedContentHash` 是空字串
 * （檔案類從來沒寫過），比不出來。所以查不到不等於沒有，呼叫端不可以拿它當
 * 「確定沒重複」的證據——同名警告那條路仍然要留著。
 *
 * 型別要一起比：檔案的指紋算的是原始 bytes、網址算的是抽出來的純文字，
 * 兩者語意不同，跨型別比中了也沒有意義。
 */
export async function findSourceByContentHash(
  db: Firestore,
  workspaceId: string,
  contentHash: string,
  type: KnowledgeSourceType,
): Promise<DuplicateSourceHit | null> {
  const hash = String(contentHash ?? '').trim()
  // ⛔空字串一定要擋在查詢之前：舊資料整批存的就是 ''，照查會撈回一整包不相干的來源
  if (!hash) return null

  try {
    // 兩個等值條件，Firestore 會合併既有的單欄位索引（不必另外部署複合索引）。
    const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .where('appliedContentHash', '==', hash)
      .limit(10)
      .get()
    for (const d of snap.docs) {
      const data = d.data() as Partial<KnowledgeSourceDoc> & { isDeleted?: boolean; deletedAt?: unknown }
      // 已經丟進回收桶的不算重複：使用者刪掉就是想重來一次
      if (data.isDeleted === true || data.deletedAt != null) continue
      if ((data.type ?? 'file') !== type) continue
      return {
        id: d.id,
        name: String(data.name ?? ''),
        type: (data.type ?? 'file') as KnowledgeSourceType,
        chunkCount: Number(data.chunkCount ?? 0),
        updatedAtMs: tsToMs(data.updatedAt),
      }
    }
    return null
  }
  catch (e) {
    // 查不到就當「不確定」——去重是加值，不該讓它擋住匯入這條主路。
    // ⛔但一定要 log：靜靜回 null 的話，去重整個失效也沒有人會知道。
    console.warn('[ai-knowledge-sources] findSourceByContentHash failed:', e)
    return null
  }
}

/** 網址正規化成比對用的 key（去 #後面、去尾斜線）：整站探頁、一次貼好幾個網址判「加過了沒」同一套 */
export function sourceUrlKey(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.href.replace(/\/$/, '')
  }
  catch {
    return url
  }
}

/**
 * 這個帳號已經加過的網址（比對用 key）。整站探頁與「一次貼好幾個網址」共用（2026-10-13 `/code-review`：
 * 後者以前每一頁都當沒加過，同一個網址加兩份、兩份每天各自重新同步，AI 反問時出現兩個一樣的選項）。
 * ⛔ 回收桶裡的不算（同 findExistingSources）：那一份已經刪了，再加一次是他要的。
 * 查詢失敗回空集合（不擋加入，只是少了「加過了」的標記），呼叫端照常加；內容指紋的守門還在後面。
 *
 * `excludeIdPrefix`：開帳讀網站（`D-125`③）用——那一份工作自己建的資料（`onb_{jobId}_…`）不算「加過了」，
 * 不然中途被砍、重做同一頁時會把自己當成別人加過的而跳過。
 */
export async function listSourceUrlKeys(
  db: Firestore,
  workspaceId: string,
  opts: { excludeIdPrefix?: string } = {},
): Promise<Set<string>> {
  try {
    const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .where('type', '==', 'url')
      .select('url', 'isDeleted', 'deletedAt')
      .limit(1000)
      .get()
    return new Set(
      snap.docs
        .filter(d => !opts.excludeIdPrefix || !d.id.startsWith(opts.excludeIdPrefix))
        .map(d => d.data() as { url?: string, isDeleted?: boolean, deletedAt?: unknown })
        .filter(d => d.isDeleted !== true && d.deletedAt == null)
        .map(d => String(d.url ?? '').trim())
        .filter(Boolean)
        .map(sourceUrlKey),
    )
  }
  catch (e) {
    console.warn('[ai-knowledge-sources] listSourceUrlKeys failed:', e)
    return new Set()
  }
}

/**
 * 取得單一 source（含 workspace 比對）。找不到回 null。
 */
export async function getSource(
  db: Firestore,
  sourceId: string,
  workspaceId: string,
): Promise<{ id: string; data: KnowledgeSourceDoc } | null> {
  const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).get()
  if (!snap.exists) return null
  const data = snap.data() as KnowledgeSourceDoc
  if (data.workspaceId !== workspaceId) return null
  return { id: snap.id, data }
}

/**
 * 重新算 chunkCount（給 source detail 顯示「目前有幾張卡」）。
 */
export async function countSourceChunks(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
): Promise<number> {
  // ⛔用 count() 聚合，不要抓文件回來數（C-49E）：`select()` **不會**降低 Firestore 的
  // 讀取計費——投影只省頻寬，一筆文件仍計一次讀。150 張卡的來源每次呼叫就是 150 次讀，
  // 而這支在單卡刪除/同步/還原/套用都會被呼叫（2026-08-11 讀取費暴衝就是這種形狀）。
  // 靠 `isDeleted` 布林欄位讓查詢層就能過濾：軟刪除時寫 true，還原時寫 false，
  // 建卡時預設 false——舊資料沒有這個欄位，所以用「!= true」語意的兩段查詢做相容：
  // 先數全部，再扣掉明確標記為已刪除的（兩次都是聚合，各約 1 次讀）。
  const base = db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
  const [allAgg, deletedAgg] = await Promise.all([
    base.count().get(),
    base.where('isDeleted', '==', true).count().get(),
  ])
  return Math.max(0, allAgg.data().count - deletedAgg.data().count)
}

/**
 * 這個來源底下「有算進方案額度」的卡有幾張——跟 `countWorkspaceChunks`（ai-knowledge-quota）
 * **同一把尺**：不含回收桶、⛔ 也不含「等你看過」的草稿（`draft`）。
 *
 * 給「蓋掉這一份會騰出多少空間」用（bulk-create 的「更新這一份」）。拿 countSourceChunks（含草稿）
 * 去扣的話，草稿本來就沒算過額度，卻被當成騰出來的空間——舊的那份有 30 張草稿，就能多塞 30 張。
 * 軟刪除會把 status 改成 disabled，所以「在回收桶的草稿」不會被扣兩次（同 countWorkspaceChunks）。
 */
export async function countSourceQuotaChunks(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
): Promise<number> {
  const base = db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
  const [allAgg, deletedAgg, draftAgg] = await Promise.all([
    base.count().get(),
    base.where('isDeleted', '==', true).count().get(),
    base.where('status', '==', 'draft').count().get(),
  ])
  return Math.max(0, allAgg.data().count - deletedAgg.data().count - draftAgg.data().count)
}

/**
 * 列出某 source 旗下的所有 chunk（給 source detail panel）。
 */
export async function listChunksBySource(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
): Promise<Array<{ id: string; title: string; content: string; tags: string[]; questions: string[]; status: string; failureReason?: string; isOverview: boolean; manuallyEditedAtMs: number; updatedAtMs: number; activeUntilMs: number; expiredAtMs: number }>> {
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .get()
  // 回收桶的卡不出現在來源明細，也不參與 resync diff / gsheet 同步比對：
  // 被比對到的話，重新加回同標題列會「更新」到墓碑卡（內容復活但狀態隱藏）而不是建新卡。
  return snap.docs.filter(d => (d.data() as any)?.deletedAt == null).map((d) => {
    const data = d.data() as any
    return {
      id: d.id,
      title: String(data?.title ?? ''),
      content: String(data?.content ?? ''),
      tags: Array.isArray(data?.tags) ? data.tags.map(String) : [],
      // 問法會一起進 embedding，是檢索命中的關鍵。不回傳的話編輯畫面看不到也改不掉——
      // 從「補知識」帶進來的客人原話（可能含電話姓名）就永遠留在那張卡上。
      questions: Array.isArray(data?.questions) ? data.questions.map(String) : [],
      status: String(data?.status ?? 'pending'),
      ...(data?.failureReason ? { failureReason: String(data.failureReason) } : {}),
      isOverview: data?.isOverview === true,
      manuallyEditedAtMs: tsToMs(data?.manuallyEditedAt),
      updatedAtMs: tsToMs(data?.updatedAt),
      activeUntilMs: tsToMs(data?.activeUntil),
      expiredAtMs: tsToMs(data?.expiredAt),
    }
  })
}

/**
 * 把一個來源底下「還活著」的卡片整批移進回收桶，回傳實際移動的張數（`C-135`）。
 *
 * 給「更新既有那一份」用：重傳一份新版說明書時，舊卡要退場、但**來源本身要留著**
 * （資料夾、產品名、同步設定、建立日期都在來源上）。用軟刪除不用真刪，是因為
 * 蓋錯了要救得回來——回收桶留 30 天。
 *
 * ⛔ 已經在回收桶的不再蓋一次：`buildChunkSoftDeletePatch` 會把 `statusBeforeDelete`
 *    記成當下的 status，而當下已經是 `disabled` → 還原時回不到刪除前的狀態。
 *
 * `keepIds`（`D-125`①，2026-10-13 拍板 A）：換新版時他選了「沿用我改過的」那幾條——留在原地、不進回收桶。
 * 驗證（是不是這一份的、有沒有改過）是呼叫端的事；這裡只照名單跳過。
 */
export async function recycleSourceChunks(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  opts: { keepIds?: Iterable<string> } = {},
): Promise<number> {
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .get()

  const keep = new Set(opts.keepIds ?? [])
  const live = snap.docs.filter(d => (d.data() as { deletedAt?: unknown })?.deletedAt == null && !keep.has(d.id))
  // 單一 batch 上限 500 writes，400 一批留餘裕（同 deleteSourceWithChunks：
  // 超過就是整批 commit 失敗，不是部分成功——舊卡一張都不會退場）
  for (let i = 0; i < live.length; i += 400) {
    const batch = db.batch()
    for (const d of live.slice(i, i + 400)) {
      batch.update(d.ref, buildChunkSoftDeletePatch((d.data() as { status?: unknown })?.status))
    }
    await batch.commit()
  }
  return live.length
}

/**
 * 刪除 source 與底下所有 chunk。給「整批退場」用。
 * 留著的原檔（`C-296`③）一起刪：資料刪了、原檔還躺在雲端，就是一份沒有人看得到、
 * 也沒有人刪得掉的客戶檔案（隱私權政策承諾過「可要求刪除」）。
 */
export async function deleteSourceWithChunks(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
): Promise<{ chunksDeleted: number }> {
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) return { chunksDeleted: 0 }

  const chunksSnap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .get()

  // 分批刪（C-49E）：單一 batch 上限 500 writes——卡片 >498 張時整批 commit 失敗，
  // 來源永遠刪不掉（不是部分刪，是全不刪）。400 一批保留餘裕。
  const refs = chunksSnap.docs.map(d => d.ref)
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch()
    for (const ref of refs.slice(i, i + 400)) batch.delete(ref)
    await batch.commit()
  }
  const tail = db.batch()
  // 變動偵測的全文暫存（subcollection）也一併清掉，避免孤兒 doc
  tail.delete(db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).collection('cache').doc('extracted'))
  tail.delete(db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId))
  await tail.commit()
  /**
   * 刪完再掃一輪（`C-308`③）：刪的同時試算表同步可能正在一條條建——上面那份名單數完之後才建的不在名單裡，
   * 資料一刪就成了「AI 會用、後台看不到也刪不掉」的孤兒（2026-10-13 正式站測試撞到 9 條）。
   * 資料文件已經刪掉了，同步那邊每建一條前都會先確認資料還在，所以這一輪之後不會再長出來。
   */
  const lateSnap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .get()
  const lateRefs = lateSnap.docs.map(d => d.ref)
  for (let i = 0; i < lateRefs.length; i += 400) {
    const batch = db.batch()
    for (const ref of lateRefs.slice(i, i + 400)) batch.delete(ref)
    await batch.commit()
  }
  if (lateRefs.length) console.warn(`[sources] ${sourceId} 刪除時同步還在建，多收掉 ${lateRefs.length} 條`)
  // 檔案來源一律照資料夾清（便宜）：路徑沒記上的情況（留存寫到一半失敗）檔案一樣可能在那裡
  if (source.data.type === 'file' || source.data.filePath) await deleteSourceFiles(workspaceId, sourceId)
  invalidateTagIndexCache(workspaceId)
  invalidateCatalogSourceCache(workspaceId)

  return { chunksDeleted: chunksSnap.size + lateRefs.length }
}

export interface UpdateSourceSettingsInput {
  refreshIntervalMinutes?: number
  onChangeBehavior?: 'notify' | 'log_only'
  name?: string
  /** 移動到指定資料夾；null = 移出資料夾（未分類） */
  folderId?: string | null
  /** 所屬產品名；'' = 清空（非單一產品來源）。改動後呼叫端要觸發該來源 reindex 才生效。 */
  productName?: string
  /** type='url'：小幅變動是否自動套用 */
  urlAutoApply?: boolean
  /**
   * type='url' 專用：改網址（原網頁被搬走 / 換網域）。
   * 沒有這個欄位的話，網頁一搬走這個來源就只能刪掉重新匯入——連帶失去手動編輯過的卡片。
   * 改網址等於換了一份內容：contentHash / pendingHash / outdatedAt 一併重設，
   * 否則會拿舊網址的指紋去比新網址，變動偵測永遠算錯。
   */
  url?: string
  /**
   * type='gsheet' 專用（`D-125`②）：把「在後台刪掉、之後不再收」的那幾列重新收回來。
   * 清空名單＋清掉內容指紋——不清指紋的話表格沒變，同步會直接跳過，那幾列要等表格別處改過才回來
   * （跟 `C-308`② 解鎖不生效同一個病）。
   */
  clearExcludedRows?: boolean
}

/**
 * 更新 source 的設定（refresh 頻率、處理方式、顯示名稱、所屬資料夾）。
 * 只動使用者可配置的欄位；不動 hash / etag / lastFetchedAt 等系統管理欄位。
 */
export async function updateSourceSettings(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  input: UpdateSourceSettingsInput,
): Promise<SourceSummary | null> {
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) return null
  if (input.clearExcludedRows === true && source.data.type !== 'gsheet') {
    throw createError({ statusCode: 400, statusMessage: '只有 Google 試算表才有「在後台刪掉、不再收的列」' })
  }

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
  if (input.clearExcludedRows === true) {
    update.gsheetExcludedTitles = []
    update.contentHash = ''
  }
  if (input.refreshIntervalMinutes != null) {
    const n = Number(input.refreshIntervalMinutes)
    update.refreshIntervalMinutes = Number.isFinite(n) ? Math.max(0, Math.min(43_200, Math.round(n))) : 0
  }
  if (input.onChangeBehavior === 'notify' || input.onChangeBehavior === 'log_only') {
    update.onChangeBehavior = input.onChangeBehavior
  }
  if (typeof input.name === 'string' && input.name.trim()) {
    update.name = input.name.trim().slice(0, 200)
  }
  if (input.folderId !== undefined) {
    // G-98：搬進的資料夾要是這個帳號的；搬進不存在的資料夾，這份資料會從側欄整份消失（找不到丟 404）
    update.folderId = await resolveKnowledgeFolderId(db, workspaceId, input.folderId)
  }
  if (typeof input.urlAutoApply === 'boolean') {
    update.urlAutoApply = input.urlAutoApply
  }
  if (typeof input.productName === 'string') {
    const clean = input.productName.trim().slice(0, 60)
    update.productName = clean || FieldValue.delete()
  }
  // 改網址：只有 url 型來源可改。換了網址就是換了一份內容 → 比對基準全部重設，
  // 並清掉失敗標記（原網址 404 才要改網址，改完就不該還顯示失敗）。
  if (typeof input.url === 'string' && input.url.trim() && source.data.type === 'url') {
    const nextUrl = input.url.trim().slice(0, 2000)
    if (!/^https?:\/\//i.test(nextUrl)) {
      throw createError({ statusCode: 400, statusMessage: '網址要以 http:// 或 https:// 開頭' })
    }
    if (nextUrl !== source.data.url) {
      update.url = nextUrl
      update.contentHash = ''
      // 卡片是從舊網址切出來的 → 基準也失效,不清會拿舊網址的指紋去判斷新網址「沒變」
      update.appliedContentHash = ''
      update.pendingHash = FieldValue.delete()
      update.outdatedAt = null
      Object.assign(update, buildSourceClearFailure(source.data.status))
    }
  }

  await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update(update)
  if (typeof input.productName === 'string') {
    // 索引流程 60s 快取要立刻失效，之後的 reindex 才吃得到新產品名；索引清單只增不刪
    invalidateSourceProductCache(sourceId)
    const clean = input.productName.trim().slice(0, 60)
    if (clean) await addWorkspaceProductName(db, workspaceId, clean)
  }
  const fresh = await getSource(db, sourceId, workspaceId)
  return fresh ? docToSourceSummary(fresh.id, fresh.data) : null
}

/**
 * 標 source「偵測到變動，等使用者確認」。
 * 由排程任務在比對到 contentHash 變了之後呼叫。
 */
export async function markSourceOutdated(
  db: Firestore,
  sourceId: string,
): Promise<void> {
  await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
    outdatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
}

/**
 * 清掉「偵測到變動」旗標（套用 re-sync 後呼叫）。
 */
export async function clearSourceOutdated(
  db: Firestore,
  sourceId: string,
): Promise<void> {
  await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
    outdatedAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  })
}

/**
 * 抓取／同步成功後要清掉的失敗標記。
 *
 * 為什麼要有這支：知識庫體檢的「來源同步失敗」紅字看的是 `status:'failed'` 與
 * `failureReason`。商家把 Google Sheet 分享權限修好、或網頁恢復了，**同步其實已經成功，
 * 但只要沒清這兩個欄位，紅字就永遠在**——使用者做完所有正確動作也無法確認自己修好了，
 * 只能反覆重做。所以每一條「成功」的路徑（排程檢查、手動立即同步、手動套用變更）
 * 都要清一次，共用這一份定義。
 *
 * `FieldValue.delete()` 對不存在的欄位是 no-op，可以無條件呼叫。
 */
export function buildSourceClearFailure(currentStatus?: string) {
  return {
    failureReason: FieldValue.delete(),
    checkFailCount: FieldValue.delete(),
    ...(currentStatus === 'failed' ? { status: 'ready' as const } : {}),
  }
}

/** 同上，直接寫進 Firestore；失敗只 log（清旗標不該讓主流程失敗） */
export async function clearSourceFailure(
  db: Firestore,
  sourceId: string,
  currentStatus?: string,
): Promise<void> {
  await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId)
    .update(buildSourceClearFailure(currentStatus))
    .catch(e => console.warn(`[sources] ${sourceId} clearFailure failed:`, e))
}
