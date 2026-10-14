import { createHash } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { FieldValue, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { KNOWLEDGE_PREVIEW_JOBS_COLLECTION, loadSourceFile } from '~~/server/utils/ai-preview-jobs'
import { deleteSourceFiles, keepOriginalFile } from '~~/server/utils/knowledge-source-files'
import { fileExtension, KNOWLEDGE_FILE_MIME_BY_EXT } from '~~/shared/knowledge-file-types'
import { requireCapability } from '~~/server/utils/workspace-auth'
import {
  countSourceChunks,
  countSourceQuotaChunks,
  invalidateCatalogSourceCache,
  recycleSourceChunks,
} from '~~/server/utils/ai-knowledge-sources'
import { resolveKnowledgeFolderId } from '~~/server/utils/ai-knowledge-folder-guard'
import { assertMaintenanceBudget, recordAiUsage } from '~~/server/utils/ai-usage'
import { assertKnowledgeChunkQuota, chunkCountsTowardQuota, invalidateKnowledgeChunkCount } from '~~/server/utils/ai-knowledge-quota'
import { parseGoogleSheetUrl } from '~~/server/utils/google-sheets'
import {
  addWorkspaceProductName,
  createKnowledgeChunk,
  KNOWLEDGE_CHUNKS_COLLECTION,
  normalizeChunkInput,
  validateChunkInput,
} from '~~/server/utils/ai-knowledge-chunks'
import { writeAuditLog } from '~~/server/utils/audit-log'
import { knowledgeTitleKey } from '~~/shared/knowledge-title-key'
import type { KnowledgeChunkStatus, KnowledgeSourceType } from '~~/shared/types/ai-knowledge'

const KNOWLEDGE_SOURCES_COLLECTION = 'knowledgeSources'

/** 錯誤訊息要講人話：「type 不符」對商家沒有意義 */
const SOURCE_TYPE_LABEL: Record<string, string> = {
  file: '檔案',
  url: '網址',
  gsheet: 'Google 試算表',
  manual: '一段文字', // 跟加入視窗同一個叫法（2026-10-12 文字審視）
}

/** 會建（或更新）一份資料的匯入種類；其餘的卡不掛在任何資料底下 */
const SOURCE_WRITING_TYPES = new Set(['file', 'url', 'gsheet', 'text'])

/** 同時跑幾張卡的 embedding。Gemini 免費層 RPM 15、付費層 1000+，5 算保守 */
const EMBED_CONCURRENCY = 5

// 分段切卡（大型目錄）單次可產出超過 50 張；150 張 × ~300ms embed / 併發 5 ≈ 9 秒，仍在請求時限內
const MAX_BULK_CHUNKS = 150

/**
 * 前端帶來、會拿去當 Firestore 文件 id（importId 還會拿去組暫存檔路徑）的字串只收英數字、`-`、`_`。
 * uuid、Firestore 自動 id、我們自己的雜湊都長這樣。
 * ⛔ 含 `/` 的 id 會被 Firestore 當成路徑、`__x__` 是保留字——`doc()` 直接丟例外，變成沒有訊息的 500。
 */
const SAFE_ID_RE = /^[\w-]{1,64}$/

function bodyId(raw: unknown, label: string): string {
  if (raw === undefined || raw === null) return ''
  const id = String(raw).trim()
  if (!id) return ''
  if (!SAFE_ID_RE.test(id) || /^__.*__$/.test(id)) {
    throw createError({ statusCode: 400, statusMessage: `${label}不對，請重新整理頁面後再試一次` })
  }
  return id
}

/** 一筆匯入做完時記在那份資料上的結果（`importDone`）：同一筆重送時原樣回給前端 */
interface ImportDone {
  /** 整包請求的指紋：內容不一樣就不是「重送」，照一般匯入處理 */
  bodyHash: string
  total: number
  indexed: number
  failed: number
  replacedChunks: number
  originalKept: boolean | null
  /** 換新版時沿用的、他改過的條數（`D-125`①）；舊紀錄沒有＝0 */
  keptEdited?: number
  /** 新版裡跟沿用那幾條同名、所以沒收的條數；舊紀錄沒有＝0 */
  skippedForKept?: number
}

/** 換新版時一次最多沿用幾條（一份資料最多 150 條，留餘裕） */
const MAX_KEEP_EDITED = 500

/** 沿用的那一條（驗過：這一份的、活著的、他改過的） */
interface KeptEdited {
  id: string
  title: string
  /** 算不算額度（草稿不算）——沿用的會繼續佔位置，騰出空間時要扣掉 */
  countsTowardQuota: boolean
}

interface ExistingSource {
  workspaceId?: string
  type?: string
  name?: string
  isDeleted?: boolean
  deletedAt?: unknown
  filePath?: string
  /** 最後一次把卡寫進這份資料的匯入（`importId`）；手動匯入沒帶就是 null */
  importId?: string | null
  /** 那筆匯入收進回收桶的舊卡張數（重送時沿用，不重收一次） */
  importReplaced?: number
  /** 那筆匯入沿用的、他改過的那幾條（`D-125`①）：重跑時照這份名單，不看這次 body 帶什麼 */
  importKeptEdited?: string[]
  importDone?: ImportDone | null
  /** 留著的原檔是哪一筆匯入留的 */
  fileImportId?: string
}

/** 在回收桶的資料（手打文字的最後一張卡被刪掉時，來源會一起進回收桶） */
function isRecycled(s: ExistingSource | undefined): boolean {
  return s?.isDeleted === true || s?.deletedAt != null
}

/**
 * POST /api/ai/knowledge/bulk-create
 * Body: {
 *   source: { type: 'file' | 'url' | 'text', name, url?, contentHash?, productName?, keepEditedChunkIds?: string[] },
 *   chunks: [{ title, content, tags[] }]
 * }
 * `keepEditedChunkIds` 只在帶 `replaceSourceId`（換新版）時有用：他改過、選了沿用的那幾條（`D-125`①）。
 * 回應多 `keptEdited`（沿用了幾條）、`skippedForKept`（新版裡同名、所以沒收的幾條）。
 *
 * 流程：建 knowledgeSource（type=text 跳過）→ 批次建 chunks（含 embedding）→ 回報每張卡狀態。
 * 失敗的卡會是 status='failed'，可由排程任務或手動 reindex 救回。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
  const body = await readBody(event)

  /**
   * importId（C-46 冪等鍵，前端帶預覽 jobId）：150 張卡 × embedding 會超過閘道 30 秒——
   * Lambda 其實建完了，前端卻收到逾時、使用者再按一次（批次匯入會自動重送一次）。
   * 有 importId 時 source 與每張卡的 id 都決定性導出：重送覆寫同一批 doc，不會留下
   * 「說有 150 條實際 30 條」的殭屍來源＋第二批重複卡。
   * 做完時把結果記在那份資料上（`importDone`）：同一包重送直接回上一次的結果，
   * ⛔ 不重建卡、不重算額度、不重新留原檔——見下面「重送」那一段。
   */
  const importId = bodyId(body?.importId, '這次匯入的編號')
  const idFor = (suffix: string) =>
    createHash('sha256').update(`bulk:${workspaceId}:${importId}:${suffix}`).digest('hex').slice(0, 32)

  /**
   * `replaceSourceId`（`C-135`）：把這批卡**蓋回既有那一份資料**，而不是新建一份。
   *
   * 為什麼要有：同名警告原本唯一的建議是「改個名字」——照做的人就製造出第三份重複
   * （2026-09-04 在 MYFEEL 看到同一本說明書並存三份的實況）。人真正想做的事是
   * 「這份我重傳了、用新的蓋掉舊的」，那就得有一條路真的做得到。
   *
   * 舊卡走**軟刪除**（進回收桶 30 天）不是真刪：蓋錯了要救得回來，
   * 而且來源本身留著＝資料夾、產品名、同步設定、卡片以外的設定都不會被洗掉。
   */
  const replaceSourceId = bodyId(body?.replaceSourceId, '要更新的那份資料編號')

  const rawChunks = Array.isArray(body?.chunks) ? body.chunks : []
  if (!rawChunks.length) {
    // 加入視窗從頭到尾講「條」、動詞是「加入」（2026-10-12 文字審視），伺服器的話也照同一套
    throw createError({ statusCode: 400, statusMessage: '請至少選一條再加入' })
  }
  if (rawChunks.length > MAX_BULK_CHUNKS) {
    throw createError({ statusCode: 400, statusMessage: `一次最多加入 ${MAX_BULK_CHUNKS} 條` })
  }

  const inputs = rawChunks.map(normalizeChunkInput)
  for (const input of inputs) {
    const err = validateChunkInput(input)
    if (err) throw createError({ statusCode: 400, statusMessage: `「${input.title || '未命名'}」這一條：${err}` })
  }

  // 列表頁的「總覽卡」與一般卡分開傳：它帶 isOverview，re-sync 時要能單獨辨識 / 重生
  const rawOverview = body?.overviewCard
  const overviewInput = rawOverview?.title && rawOverview?.content
    ? { ...normalizeChunkInput(rawOverview), isOverview: true }
    : null
  if (overviewInput) {
    const err = validateChunkInput(overviewInput)
    if (err) throw createError({ statusCode: 400, statusMessage: `總表：${err}` })
  }

  const db = getDb()

  // text 也建（type='manual'，C-47）：原本 text 不建 source → sourceId 恆 null、
  // 使用者確認過的「所屬產品」從未寫入任何地方（畫面有欄位、系統還花一次 LLM 預填＝白花），
  // 整批卡變成 7/31 稽核反覆咬人的「無主卡」——客人指名問另一台時被拿去混答，
  // 而且不屬於任何來源、無法整批管理。手寫單卡（create.post.ts）早就這樣做了，比照辦理。
  const sourceType = String(body?.source?.type ?? '').trim() as KnowledgeSourceType | 'text'
  const writesSource = SOURCE_WRITING_TYPES.has(sourceType)
  /**
   * ⛔ 要「更新既有那一份」，這次匯入就一定要是會寫資料的那幾種。
   * 以前沒擋：帶 replaceSourceId、source 卻缺或寫成 manual，額度照「會騰出舊卡」扣掉，
   * 實際上卻不會收任何舊卡（下面那段根本不跑）、新卡照建——每送一次就多塞一份舊卡數量的卡。
   */
  if (replaceSourceId && !writesSource) {
    throw createError({ statusCode: 400, statusMessage: '要更新既有那一份資料，這次匯入要是檔案、網址、Google 試算表或貼上的文字；請重新整理後再試' })
  }

  // 這批卡要掛在哪一份資料底下：更新既有＝那一份；有 importId＝決定性 id（重送落在同一份）
  const targetSourceId = writesSource ? (replaceSourceId || (importId ? idFor('source') : '')) : ''
  const targetSnap = targetSourceId
    ? await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(targetSourceId).get()
    : null
  const target = targetSnap?.exists ? targetSnap.data() as ExistingSource : undefined
  const targetMine = !!target && target.workspaceId === workspaceId
  // 這筆匯入自己會建的卡（決定性 id）；重送時拿來數「會被原地覆寫的」與重組回應
  const ownChunkIds = importId
    ? [...inputs.map((_: unknown, i: number) => idFor(`chunk:${i}`)), ...(overviewInput ? [idFor('overview')] : [])]
    : []

  /**
   * ── 重送（逾時後同一包再送一次）──────────────────────────
   * 前端在 502／504／408／斷線時會用**同一包**再送一次：第一次可能其實做完了、只是閘道先逾時。
   * 這時直接回第一次的結果（形狀一樣，多一個 `alreadyImported: true`），⛔ 什麼都不重做：
   *  · 重建卡＝第二次 embedding 費，「更新這一份」還會把剛建好的新卡當舊卡收進回收桶；
   *  · 重算額度＝剛好收到滿的那一批，重送一定被自己剛建好的卡擋成「知識量不夠」，畫面說失敗、其實成功了；
   *  · 重新留原檔＝暫存那份可能已經清掉，複製失敗就會走「清掉舊原檔」把剛留好的原檔刪了。
   * 擺在額度與維運額度檢查**之前**：第一次已經過了這兩關，剛建的卡與剛記的用量不該讓重送反過來被擋。
   */
  const bodyHash = importId ? createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex').slice(0, 32) : ''
  const done = importId && targetMine && target?.importId === importId ? target.importDone : null
  if (done && done.bodyHash === bodyHash) {
    return replayImport(db, workspaceId, targetSourceId, done, ownChunkIds)
  }

  // 維運額度前置檢查（C-45）：讓使用者在開始前就看到「額度不足」，而不是建到一半死
  await assertMaintenanceBudget(workspaceId)

  // ── 「更新既有那一份」的守門：一定要在算額度、收舊卡**之前**驗 ─────────
  if (replaceSourceId) {
    // 跨租戶保護：找不到或不是自己的，寧可報錯也不要默默改成「新建一份」——
    // 使用者按的是「更新」，結果多出一份重複，正是這條路要修掉的病。
    // ⛔ 在回收桶的也一樣：照蓋下去會把那份資料從回收桶整份救回來（payload 帶 isDeleted:false），人按的是「更新」不是「還原」
    if (!targetMine || isRecycled(target)) {
      throw createError({ statusCode: 404, statusMessage: '找不到要更新的資料（可能已被刪除），請重新整理後再試' })
    }
    /**
     * ⛔ 型別不同不准覆蓋（`C-139`）。
     * 同名警告列的是「名字相同」的所有資料，不分種類——上傳**檔案**時若按到一份
     * **Google 試算表**的「更新這一份」，下面的 merge 會把 type 改成 file、url 清空，
     * 但 `gsheetId` / `gsheetGid` 還留著：那份資料變成雜種，**自動同步從此不再跑**
     * （型別已經不是 gsheet），而畫面上完全看不出來。
     * 前端也會擋（不給按鈕），但前端擋不算擋——真正的守門在這裡。
     */
    const existingType = String(target?.type ?? '')
    const incomingType = sourceType === 'text' ? 'manual' : sourceType
    if (existingType && existingType !== incomingType) {
      throw createError({
        statusCode: 400,
        statusMessage: `「${String(target?.name ?? '這份資料')}」是${SOURCE_TYPE_LABEL[existingType] ?? '另一種'}來源，不能用${SOURCE_TYPE_LABEL[incomingType] ?? '這一種'}覆蓋它；請改名字另外建一份`,
      })
    }
  }

  /**
   * 同一筆匯入的**重跑**：上一次已經寫過這份資料、卻沒有記下「做完了」（還在做、做到一半斷了，
   * 或這次送來的內容跟上一次不一樣）。新建的那種：決定性 id 的資料已經在了；
   * 更新既有的那種：資料上記的是這筆匯入（舊卡在寫這個記號之前就收完了）。
   */
  const resuming = !!importId && targetMine && (replaceSourceId ? target?.importId === importId : true)
  const ownSnaps = resuming ? await db.getAll(...ownChunkIds.map(id => db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id))) : []

  /**
   * 換新版時沿用他改過的那幾條（`D-125`①，2026-10-13 拍板 A）：畫面先列出「這份有 N 條你改過」、預設全勾，
   * 勾的那幾條帶在 `source.keepEditedChunkIds`。⛔ 不信前端：一條條驗是這一份的、還活著、真的改過（manuallyEditedAt），
   * 不合的安靜略過（不是錯——可能他打開清單之後又解了鎖、或刪了那一條）。
   * 沿用的留在原地不進回收桶；新版裡同名的那一條就不收，免得同一件事兩條。
   * 重跑（同一筆匯入再做一次）照**上一次記下的名單**：那幾條上一次就沒進回收桶，這次 body 帶什麼都不能改變這件事。
   */
  const keepRequested: unknown[] = !replaceSourceId
    ? []
    : resuming && Array.isArray(target?.importKeptEdited)
      ? target!.importKeptEdited!
      : Array.isArray(body?.source?.keepEditedChunkIds) ? body.source.keepEditedChunkIds : []
  const kept = replaceSourceId ? await resolveKeptEdited(db, workspaceId, replaceSourceId, keepRequested) : []
  const keptKeys = new Set(kept.map(k => knowledgeTitleKey(k.title)).filter(Boolean))
  // 這次真的要建的（留著原本的序號：有 importId 時 id 照序號算，重送要落在同一批 id 上）
  const toCreate = inputs
    .map((input: (typeof inputs)[number], idx: number) => ({ input, idx }))
    .filter((x: { input: (typeof inputs)[number] }) => !keptKeys.has(knowledgeTitleKey(x.input.title)))
  const skippedForKept = inputs.length - toCreate.length

  /**
   * 方案知識量前置檢查（D-69 拍板④）：同 assertMaintenanceBudget 的用意——
   * 在開始 embedding 之前就講清楚「不夠」，而不是建到一半才死。
   *  ① 總表也是一條、也算額度（`C-296`）；
   *  ② 等一下就不再算額度的卡要扣掉——「更新這一份」的舊卡會進回收桶；同一筆匯入重跑時，
   *     自己上一次建好的卡會被原地覆寫（決定性 id），不會變兩張。
   * ⛔ 扣多少要跟額度**同一把尺**（countWorkspaceChunks：不含回收桶、不含草稿）：草稿本來就沒算過額度，
   *    把它當成騰出來的空間，舊的那份有幾張草稿就能多塞幾張。
   * ⛔ 重跑只數**這筆匯入自己的卡**，不數整份資料：資料底下可能還有手寫加進去的卡，那些不會被覆寫；
   *    而且只數這次真的會覆寫的那幾個 id（跟沿用那幾條同名、這次不建的不算）。
   * ⛔ 沿用的那幾條（`D-125`①）不進回收桶、照樣佔位置：騰出來的空間要扣掉它們，新版裡同名不收的也不算要加的。
   */
  const overviewAdding = overviewInput ? 1 : 0
  const writeIds = new Set(importId
    ? [...toCreate.map((x: { idx: number }) => idFor(`chunk:${x.idx}`)), ...(overviewInput ? [idFor('overview')] : [])]
    : [])
  const freed = resuming
    ? ownSnaps.filter(s => writeIds.has(s.id) && countsTowardQuota(s, workspaceId)).length
    : replaceSourceId
      ? Math.max(0, await countSourceQuotaChunks(db, workspaceId, replaceSourceId) - kept.filter(k => k.countsTowardQuota).length)
      : 0
  await assertKnowledgeChunkQuota(workspaceId, toCreate.length + overviewAdding - freed)

  let replacedChunks = 0

  // ── 建 knowledgeSource ────────────────────────
  let sourceId: string | null = null
  let keepFilePromise: Promise<boolean> | null = null
  if (writesSource) {
    sourceId = targetSourceId || uuidv4()
    const now = FieldValue.serverTimestamp()
    const sourceUrl = String(body?.source?.url ?? '').trim()

    // gsheet：解析出 id/gid 供自動同步比對（不靠 url 字串），預設每小時自動同步
    let gsheetFields: Record<string, unknown> = {}
    if (sourceType === 'gsheet') {
      const ref = parseGoogleSheetUrl(sourceUrl)
      if (!ref) throw createError({ statusCode: 400, statusMessage: '這不是有效的 Google 試算表連結' })
      gsheetFields = {
        gsheetId: ref.spreadsheetId,
        gsheetGid: ref.gid,
        gsheetAutoApply: body?.source?.autoApply !== false,
        // 這批卡是照「每個非說明頁都讀」整理的（`C-296`）；同步要用同一套，見 gsheet-sync
        gsheetTabRule: 'all',
      }
    }

    // 自動同步頻率（分鐘）：gsheet 每小時、url 每天、檔案不自動
    const refreshIntervalMinutes = sourceType === 'gsheet' ? 60 : sourceType === 'url' ? 1440 : 0

    // 產品名（P1-1）：匯入預覽自動偵測、使用者確認後帶進來。先寫進 source doc 再建卡，
    // 底下 createKnowledgeChunk → runIndexOnChunk 會即時繼承（embedding 前綴 + 卡片欄位）。
    const productName = String(body?.source?.productName ?? '').trim().slice(0, 60)

    /**
     * G-98：資料夾要是這個帳號的（填了不存在的，這份資料會從側欄整份消失）。
     * ⛔ 一定要在下面「舊卡進回收桶」之前驗：驗到一半才 404，舊卡已經被搬走、新卡卻沒建。
     */
    const folderId = await resolveKnowledgeFolderId(db, workspaceId, body?.source?.folderId)

    // ── 「更新既有那一份」：接管既有 source id，舊卡先進回收桶 ──────────
    if (replaceSourceId && !resuming) {
      // 舊卡進回收桶（30 天內救得回來）；批次與「已在回收桶不重蓋」的規矩收在 utils 裡。
      // 他選了沿用的那幾條留在原地（`D-125`①）
      replacedChunks = await recycleSourceChunks(db, workspaceId, sourceId, { keepIds: kept.map(k => k.id) })
    }
    else if (resuming) {
      // 重跑：舊卡上一次就收完了（收完才寫下這筆匯入的記號）。⛔ 不再收一次——
      // 這時候「還活著的卡」是這筆匯入自己剛建好的新卡，收進去回收桶會多出一批假的「被蓋掉的舊卡」
      replacedChunks = Number(target?.importReplaced ?? 0)
    }

    const sourcePayload: Record<string, unknown> = {
      workspaceId,
      // 貼上文字沒有可重抓的外部來源 → 歸 manual（與手寫單卡同類：不排同步、不偵測變動）
      type: sourceType === 'text' ? 'manual' : sourceType,
      name: String(body?.source?.name ?? '').trim(),
      url: sourceUrl,
      folderId,
      // 先寫空的；檔案來源的原檔由 keepImportedOriginal 複製好再補上（`C-296`③，失敗就維持空的）
      filePath: '',
      contentHash: String(body?.source?.contentHash ?? '').trim(),
      // 這批卡就是從這一版內容切出來的 → 同時當成「重新同步」的比對基準。
      // 沒有基準的來源（舊資料、貼上文字）第一次重新同步仍會照跑重切＋比對。
      appliedContentHash: String(body?.source?.contentHash ?? '').trim(),
      etag: '',
      lastModified: '',
      refreshIntervalSec: 0,
      refreshIntervalMinutes,
      onChangeBehavior: 'notify',
      generateOverview: Boolean(overviewInput),
      ...(productName ? { productName } : {}),
      ...gsheetFields,
      lastFetchedAt: now,
      outdatedAt: null,
      status: 'ready',
      isDeleted: false, // listSources 查詢層過濾用
      chunkCount: toCreate.length + (overviewInput ? 1 : 0) + kept.length,
      // 重送用的記號（見上面「重送」）：做完才補 importDone；沒帶 importId 的匯入一律清掉上一筆的記號，
      // ⛔ 不清的話，那份資料的卡已經換過了，上一筆匯入晚到的重送卻還會拿到「做完了」
      importId: importId || null,
      importReplaced: replacedChunks,
      // 這筆匯入沿用了哪幾條（`D-125`①）：跟 importReplaced 同一個道理，重跑時照這份、⛔ 不重新決定
      importKeptEdited: kept.map(k => k.id),
      importDone: null,
      createdAt: now,
      updatedAt: now,
    }

    if (replaceSourceId || resuming) {
      /**
       * 更新既有資料＝**只蓋這次真的重傳的東西**，其餘一律留著。
       * ⛔不可以整包覆蓋：那會把使用者在這份資料上做過的設定洗掉——所屬資料夾
       * （沒帶就是「不改」，不是「移出資料夾」）、同步頻率、Google Sheet 的
       * 分頁對應、建立日期。整包覆蓋洗掉設定這一課已經在金流的續扣資料上付過一次錢。
       */
      delete sourcePayload.createdAt
      delete sourcePayload.refreshIntervalMinutes
      delete sourcePayload.onChangeBehavior
      if (typeof body?.source?.folderId !== 'string') delete sourcePayload.folderId
      // 重跑：上一次可能已經把原檔留好了。⛔ 不重置成空的——重置了，那份原檔就變成沒人指得到的孤兒
      if (resuming) delete sourcePayload.filePath
      // 產品名沒帶＝不改（`...(productName ? …)` 本來就不會塞進去，這裡只是把話講明）
      await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).set(sourcePayload, { merge: true })
    }
    else {
      await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).set(sourcePayload)
    }
    // 新型錄來源要讓答題端的 dedupeBySource 豁免立刻生效（不必等 60s 快取過期）
    if (overviewInput) invalidateCatalogSourceCache(workspaceId)
    // 產品索引自動維護（只增不刪）；建卡前先併入，讓 pickCardProduct 這批就吃得到
    if (productName) await addWorkspaceProductName(db, workspaceId, productName)
    // 原檔留著（`C-296`③）：跟下面建卡**同時**進行——這個請求本來就逼近閘道逾時，不能再串一段上去
    if (sourceType === 'file' && importId) {
      keepFilePromise = resuming && target?.filePath && target?.fileImportId === importId
        // 這筆匯入上一次就留好了：⛔ 不再複製。整理工作那份暫存可能已經清掉，複製失敗會走
        // 「清掉舊原檔」那條路，把剛留好的這一份刪掉
        ? Promise.resolve(true)
        : keepImportedOriginal(db, workspaceId, sourceId, importId, String(body?.source?.fileName ?? ''), !!replaceSourceId)
    }
  }

  // ── 批次建立 chunks（含 embedding），用 concurrency 控速 ──────────
  // skipUsageRecording:150 卡逐卡記帳會對同一份月用量文件連打(~15 writes/s,被節流
  // 的寫入靜默漏記),改累計 token、最後整批記一次
  type ResultRow = { id: string; status: KnowledgeChunkStatus; title: string; failureReason?: string }
  const results: ResultRow[] = new Array(toCreate.length)
  let totalEmbeddingTokens = 0

  let cursor = 0
  async function worker() {
    while (cursor < toCreate.length) {
      const pos = cursor++
      const { input, idx } = toCreate[pos]!
      // id 照「在這一包裡的序號」算（不是照這次要建的第幾條）：沿用的名單不同，同一條的 id 也不會變
      const chunkId = importId ? idFor(`chunk:${idx}`) : uuidv4()
      const r = await createKnowledgeChunk(db, {
        workspaceId,
        chunkId,
        ...input,
        sourceId,
        skipUsageRecording: true,
      })
      if (r.status === 'indexed') totalEmbeddingTokens += r.embeddingTokens
      results[pos] = { id: r.id, status: r.status, title: input.title, failureReason: r.failureReason }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, toCreate.length) }, worker))

  // ── 總覽卡（若有）：最後單獨建一張，帶 isOverview ──────────────────
  if (overviewInput) {
    const r = await createKnowledgeChunk(db, {
      workspaceId,
      chunkId: importId ? idFor('overview') : uuidv4(),
      ...overviewInput,
      sourceId,
      skipUsageRecording: true,
    })
    if (r.status === 'indexed') totalEmbeddingTokens += r.embeddingTokens
    results.push({ id: r.id, status: r.status, title: overviewInput.title, failureReason: r.failureReason })
  }

  // 整批一次記帳
  if (totalEmbeddingTokens > 0) {
    await recordAiUsage(workspaceId, { buildEmbeddingTokens: totalEmbeddingTokens })
  }

  const indexed = results.filter(r => r.status === 'indexed').length
  const failed = results.filter(r => r.status === 'failed').length

  // 原檔那一段（跟建卡同時跑的）在回應前收尾；它自己吞錯，不會讓匯入失敗。
  // 有沒有留成要回給畫面講——⛔ 沒留成卻什麼都不說，之後找「下載原檔」才發現沒有
  const originalKept = keepFilePromise ? await keepFilePromise : null

  // chunkCount 回寫實數（建 source 時寫的是「預計」數）：中途死掉重跑後這裡會補正，
  // 不再留下「說有 150 條、實際 30 條」的殭屍來源。
  // 同一筆寫入記下「這筆匯入做完了」（importDone）：之後同一包重送就直接回這份結果。
  // 寫不成不擋匯入——重送會走「重跑」那條路（覆寫同一批卡），只是多花一次 embedding。
  if (sourceId) {
    const actual = await countSourceChunks(db, workspaceId, sourceId)
    const importDone: ImportDone | null = importId
      ? { bodyHash, total: results.length, indexed, failed, replacedChunks, originalKept, keptEdited: kept.length, skippedForKept }
      : null
    await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId)
      .update({ chunkCount: actual, updatedAt: FieldValue.serverTimestamp(), ...(importDone ? { importDone } : {}) })
      .catch(e => console.warn(`[bulk-create] ${sourceId} 張數／匯入記號沒寫成（重送會整批重跑）:`, (e as Error)?.message))
  }

  invalidateKnowledgeChunkCount(workspaceId)

  /*
   * 稽核（`C-254`）：一次進來上百張卡，是知識庫單次變動最大的一條路，也是計費維度。
   * ⛔ 三個數字都要記（成功／失敗／被蓋掉）——只記「匯入了 150 張」而不講失敗幾張，
   *    就是這個專案一再踩到的「沉默地少給資料」。
   * ⚠️ `replacedChunks` 是被蓋掉的舊卡：人事後問「舊的那份去哪了」，答案只在這裡。
   * ⚠️ 重跑要講出來：同一份資料兩筆「匯入 150 張」的紀錄，看的人會以為匯了兩次、有 300 張。
   */
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledge.bulkCreate',
    ...(sourceId ? { targetId: sourceId } : {}),
    after: {
      name: String(body?.source?.name ?? ''),
      itemsCount: results.length,
      chunkIdsCount: indexed,
      failedItemsCount: failed,
    },
    note: `加入 ${results.length} 條，成功 ${indexed} 條${failed ? `、失敗 ${failed} 條` : ''}`
      + (replaceSourceId ? `；換掉原本那一份，舊的 ${replacedChunks} 條進了回收桶` : '')
      // `D-125`①：沿用了哪幾條要查得到——「我改過的那條怎麼沒照新版」答案在這裡
      + (kept.length ? `；你改過的 ${kept.length} 條沿用原本的內容${skippedForKept ? `（新版裡同名的 ${skippedForKept} 條沒有收）` : ''}` : '')
      + (resuming ? '；這是同一筆匯入再送一次（上一次逾時或中斷），原地覆寫，沒有多出一份' : ''),
  }, db)

  return {
    sourceId,
    total: results.length,
    indexed,
    failed,
    /** 「更新既有資料」時被移進回收桶的舊卡張數；結果頁要講出來（人有權知道舊的去哪了） */
    replacedChunks: replaceSourceId ? replacedChunks : 0,
    /** 換新版時沿用的、他改過的條數（`D-125`①）；沒有＝0 */
    keptEdited: kept.length,
    /** 新版裡跟沿用那幾條同名、所以這次沒收的條數；沒有＝0 */
    skippedForKept,
    /** 檔案來源：原檔有沒有留下來（`C-296`③）；不是檔案來源是 null */
    originalKept,
    items: results,
    /** true＝同一包重送、上一次就做完了，這次什麼都沒重做（見「重送」那一段） */
    alreadyImported: false,
  }
})

/** 跟 countWorkspaceChunks 同一把尺：在、是這個帳號的、不在回收桶、不是草稿 */
function countsTowardQuota(snap: DocumentSnapshot, workspaceId: string): boolean {
  if (!snap.exists) return false
  const d = snap.data() as { workspaceId?: string, isDeleted?: boolean, status?: string } | undefined
  return d?.workspaceId === workspaceId && chunkCountsTowardQuota(d)
}

/**
 * 同一包重送、上一次就做完了：回上一次的結果。
 * 張數照上一次記下的（跟第一次回給畫面的一樣）；每張卡的狀態讀現在的（只多花這幾張的讀取，
 * 而且只有重送才會走到——失敗的卡被排程救回來的話，這裡看到的是救回來之後的樣子）。
 */
async function replayImport(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  done: ImportDone,
  chunkIds: string[],
) {
  const snaps = chunkIds.length
    ? await db.getAll(...chunkIds.map(id => db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id)))
    : []
  const items = snaps
    .filter(s => s.exists && (s.data() as { workspaceId?: string } | undefined)?.workspaceId === workspaceId)
    .map((s) => {
      const d = s.data() as { title?: string, status?: KnowledgeChunkStatus, failureReason?: string }
      return {
        id: s.id,
        status: (d.status ?? 'pending') as KnowledgeChunkStatus,
        title: String(d.title ?? ''),
        ...(d.failureReason ? { failureReason: String(d.failureReason) } : {}),
      }
    })
  return {
    sourceId,
    total: done.total,
    indexed: done.indexed,
    failed: done.failed,
    replacedChunks: done.replacedChunks,
    keptEdited: done.keptEdited ?? 0,
    skippedForKept: done.skippedForKept ?? 0,
    originalKept: done.originalKept,
    items,
    alreadyImported: true,
  }
}

/**
 * 換新版時「沿用他改過的」那幾條，一條條驗過（`D-125`①）：格式對、這個帳號的、這一份的、
 * 不在回收桶、真的改過（manuallyEditedAt）、不是總覽。不合的安靜略過——不是錯，只是不沿用。
 * ⛔ id 格式先擋：含 `/` 的 id 丟進 doc() 會變成沒有訊息的 500（同 bodyId）。
 */
async function resolveKeptEdited(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  raw: unknown[],
): Promise<KeptEdited[]> {
  const ids = [...new Set(raw.map(v => String(v ?? '').trim()).filter(id => SAFE_ID_RE.test(id) && !/^__.*__$/.test(id)))]
    .slice(0, MAX_KEEP_EDITED)
  if (!ids.length) return []
  const snaps = await db.getAll(...ids.map(id => db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id)))
  const out: KeptEdited[] = []
  for (const s of snaps) {
    if (!s.exists) continue
    const d = s.data() as {
      workspaceId?: string, sourceId?: string | null, deletedAt?: unknown, isDeleted?: boolean
      manuallyEditedAt?: unknown, isOverview?: boolean, title?: string, status?: string
    } | undefined
    if (!d || d.workspaceId !== workspaceId || d.sourceId !== sourceId) continue
    if (d.deletedAt != null || d.isDeleted === true) continue
    if (d.manuallyEditedAt == null || d.isOverview === true) continue
    out.push({ id: s.id, title: String(d.title ?? ''), countsTowardQuota: chunkCountsTowardQuota(d) })
  }
  return out
}

/**
 * 把整理工作留著的原檔複製成這份資料的原檔（`C-296`③）。⛔ 永遠不丟錯：卡片才是主角。
 * 工作要是**這個帳號的**、而且真的存了原檔才做——importId 是前端帶的，不能拿別家的工作來複製。
 * 「更新這一份」卻留存失敗時，把舊版的原檔一起清掉：寧可沒有「下載原檔」，
 * 也不要讓人下載到一份跟現在的知識對不上的舊版。
 */
async function keepImportedOriginal(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  jobId: string,
  rawFileName: string,
  replacing: boolean,
): Promise<boolean> {
  try {
    const job = (await db.collection(KNOWLEDGE_PREVIEW_JOBS_COLLECTION).doc(jobId).get()).data() as
      { workspaceId?: string, sourceFile?: string | null } | undefined
    const jobFile = job?.workspaceId === workspaceId ? String(job?.sourceFile ?? '') : ''
    const ext = fileExtension(jobFile) || 'bin'
    // 檔名只拿來當「下載時存成什麼名字」，不碰路徑；斜線與控制字元換掉
    let fileName = rawFileName.trim().replace(/[\\/\u0000-\u001F]/g, '_').slice(0, 200) || '原檔'
    // 資料名稱被改成「W1 使用說明書」這種沒副檔名的，下載下來會是一個打不開的檔
    if (fileExtension(fileName) !== ext) fileName = `${fileName}.${ext}`
    const kept = jobFile
      ? await keepOriginalFile({
          workspaceId,
          sourceId,
          readBytes: () => loadSourceFile(workspaceId, jobId, jobFile),
          ext,
          fileName,
          contentType: KNOWLEDGE_FILE_MIME_BY_EXT[ext] ?? 'application/octet-stream',
        })
      : null
    if (kept) {
      await db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(sourceId).update({
        filePath: kept.filePath,
        fileName: kept.fileName,
        fileSize: kept.fileSize,
        fileContentType: kept.fileContentType,
        // 記下是哪一筆匯入留的：同一筆重跑時看到這個就不再複製（見呼叫端）
        fileImportId: jobId,
      })
      return true
    }
    if (replacing) await deleteSourceFiles(workspaceId, sourceId)
    return false
  }
  catch (e) {
    console.warn(`[bulk-create] 原檔留存失敗（不擋匯入）${sourceId}:`, (e as Error)?.message)
    // 檔可能已經存進雲端、只是資料沒記上路徑：清掉，免得留下一份沒人指得到的孤兒檔
    await deleteSourceFiles(workspaceId, sourceId)
    return false
  }
}
