/**
 * 知識庫「上傳預覽」的非同步 job + 輪詢狀態機。
 *
 * 為什麼要這個：preview-chunks 是同步 API，一個請求裡把「抽文字 → LLM 整理（+OCR
 * +總表）」整包做完；長 PDF 會超過 Amplify/CloudFront 的閘道逾時（~30s）→ 504。
 *
 * 設計（順這個 codebase 的既有紋理：每個請求壓在時限內、溢出排 Firestore）：
 * - 建 job 時把「快且會報錯」的抽取先做掉（讓壞檔/加密當場報錯），重活留給輪詢。
 * - 前端每 ~2s 輪詢一次，每次 advanceWork **只推進一個有界單位**（一批 OCR 頁 / 一段整理 /
 *   一次總表），每步都壓在逾時內 → 永不 504。
 * - 大文字放 Storage 的 work.json（無 1 MiB 限制）；Firestore job 文件只留狀態/進度/lease。
 * - lease + cursor 讓中途被閘道掐斷的一步能在 lease 過期後被下一輪重跑，不重跑已完成的步。
 */
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { getDb, getStorage } from './firebase'
import {
  CHUNK_CONCURRENCY,
  chunkSegment,
  ENRICH_BATCH_SIZE,
  enrichCardBatch,
  isChunkTruncationError,
  MAX_TOTAL_CHUNKS,
  segmentText,
  splitSegmentInHalf,
  summarizeAsOverviewCard,
} from './ai-knowledge-chunker'
import { ocrPdfWithGemini, MAX_RAW_TEXT_LEN } from './ai-source-extractors'
import { splitPdfPageRange } from './pdf-split'
import { KNOWLEDGE_SOURCES_COLLECTION } from './ai-knowledge-sources'
import { getWorkspaceProductNames, KNOWLEDGE_CHUNKS_COLLECTION } from './ai-knowledge-chunks'
import { recordAiUsage } from './ai-usage'
import type { ChunkInput } from './ai-knowledge-chunks'
import { normalizeForCompare, type DiffResult } from './ai-knowledge-resync'

export const KNOWLEDGE_PREVIEW_JOBS_COLLECTION = 'knowledgePreviewJobs'

/** 單批 OCR 的頁數：壓在閘道逾時內，同時控制 job 步數。5 頁 ≈ 15–25s。 */
export const OCR_PAGE_BATCH = 5

/** 整理撞輸出上限時「對半再切」的下限；小於此就不再切（真的還失敗代表非截斷問題）。 */
export const MIN_SEGMENT_SPLIT_LEN = 1500

/**
 * 單輪同時切幾段。序列版在長文件上比「改成背景作業之前」還慢(每段一次來回),
 * 這裡讓一輪並行跑數段;單輪 wall clock ≈ 一次 LLM latency,仍遠低於閘道逾時。
 *
 * **直接沿用 chunker 的 CHUNK_CONCURRENCY**:兩者管的是同一份 Gemini 速率預算,
 * 分成兩個旋鈕的話,之後有人因為 429 調了其中一個、另一個還留在舊值。
 */
export { CHUNK_CONCURRENCY as CHUNK_PARALLEL } from './ai-knowledge-chunker'

/** claim 一步的租約時間；poll 中途被閘道 504，過了這段時間下一輪可重接。 */
/**
 * 單步租約。90 秒 > 單步最壞值（一批 OCR 正常 15–25s，Gemini 尖峰 50–60s）——
 * 原本 45 秒短於最壞單步：租約到期被下一次輪詢（1.2s 間隔）搶走，同一批 OCR
 * 重跑重收費；配合每步續租（[jobId].get 的迴圈）與 work.json 版本鎖雙保險。
 */
export const JOB_LEASE_MS = 90_000

/** job 存活時間；超過由 cleanup task 連同 Storage temp 一起刪。 */
export const JOB_TTL_MS = 60 * 60 * 1000

export type PreviewJobStatus = 'processing' | 'done' | 'error' | 'cancelled'
export type PreviewJobPhase = 'ocr' | 'chunk' | 'enrich' | 'overview' | 'finalize' | 'done'

/** 建 job 時鎖定的來源輸入（抽取用的原始參數） */
export interface PreviewJobInput {
  type: 'file' | 'url' | 'text' | 'gsheet'
  fileName?: string
  contentType?: string
  url?: string
  text?: string
  name?: string
  generateOverview: boolean
  /**
   * 「重新同步」工作：對這個既有來源重整理並在 finalize 算 diff（取代舊的同步式
   * resync-preview——一個請求做完抽取＋LLM 整理＋比對,大頁面必撞閘道逾時,
   * 與當年 preview-chunks 504 同病）。有值時 finalize 跳過同名偵測 / 認產品名 /
   * 匯入守門（那些是「新來源」的檢查,對既有來源的重切會全部誤報）。
   */
  resyncSourceId?: string
}

export interface ExistingMatch {
  id: string
  name: string
  chunkCount: number
  updatedAtMs: number
}

/** 放在 Storage work.json 的完整工作狀態（含大文字與累積結果）。 */
export interface WorkState {
  input: PreviewJobInput
  phase: PreviewJobPhase
  // 抽取結果
  sourceName: string
  sourceUrl: string
  sourceType: string
  rawLength: number
  truncated: boolean
  meta: Record<string, string | number>
  ocrUsed: boolean
  // OCR 進度（掃描檔）
  ocrPageTotal: number
  ocrPageCursor: number
  ocrText: string
  // 整理進度
  segments: string[]
  segmentCursor: number
  // 補問法進度（gsheet / 乾淨 xlsx 的一列一卡：卡片沒有 questions，逐批補）
  enrichCursor: number
  /** 補問法失敗的批數（C-49B）：>0 收尾時要警告——「不擋匯入」不等於「不告訴使用者」 */
  enrichFailedBatches?: number
  // 累積產出
  chunks: ChunkInput[]
  overviewCard: ChunkInput | null
  existingMatches: ExistingMatch[]
  usage: { inputTokens: number; outputTokens: number }
  /** 已入帳的部分(累計值);usage 減掉它就是這次要記的差額。見 flushJobUsage */
  usageFlushed?: { inputTokens: number; outputTokens: number }
  /** 匯入前健檢警告（表格來源：示範列沒換、重複問題、合併儲存格等）；提醒不擋匯入 */
  warnings: string[]
  /** 自動偵測的產品名（finalize 時 LLM 判定；多產品 / 平台頁為空）。預填給使用者確認可改。 */
  suggestedProductName?: string
  /**
   * 網址來源這次抓到的內容指紋。匯入時隨 source 一起存成 appliedContentHash
   * （＝「這批卡是從這一版網頁切出來的」），之後按「重新同步」才有基準可以判斷
   * 「網頁到底有沒有變」，不必每次都重跑 LLM 切卡去比兩批生成結果。
   */
  extractedHash?: string
  // ── resync 工作專用(input.resyncSourceId 有值時)──
  /** finalize 算出的新舊卡差異 */
  resyncDiff?: DiffResult
  /** 這份內容的指紋;apply 帶回寫,對應「這份 diff 用的內容」 */
  resyncContentHash?: string
  /** 這次「實際從網頁抓到」的字數(縮水判定要用它,不能用 LLM 重寫後的卡片字數) */
  resyncFetchedChars?: number
  /** 內容縮水偵測:抓到的字數或切出的卡數暴跌、且真有卡消失 → 疑似動態頁/抓取故障 */
  resyncShrink?: { oldChars: number; newChars: number; oldCards: number; newCards: number } | null
}

/** Firestore job 文件（保持極小） */
export interface PreviewJobDoc {
  workspaceId: string
  createdBy: string
  status: PreviewJobStatus
  phase: PreviewJobPhase
  progress: { done: number; total: number; label: string }
  error: string | null
  /** 上傳到 Storage 的原檔檔名（掃描檔 OCR 才有），null = 無 */
  sourceFile: string | null
  /** 租約到期 ms epoch；0 = 未被 claim */
  leaseUntil: number
  /**
   * 這份工作「沒人在看的時候要不要由排程繼續推」（`D-50` 簡化 3）。
   *
   * ⛔ 預設 false，只有**單筆匯入**會設 true。原因是「做完之後有沒有人收」：
   *  · 單筆匯入：jobId 落在 localStorage，使用者回來就接得回結果 → 值得推。
   *  · 整站匯入的每一頁：`bulk-create` 只在那個 worker 裡呼叫，人一走結果就沒人收。
   *  · 重新同步：產物是新舊比對，只活在前端流程裡。
   * 不分辨的話，排程會付完整的 OCR／AI 費用把「沒人要的工作」做完再把結果丟掉
   * （2026-09-03 code review 抓到；那一版是無條件推所有 processing 的工作）。
   */
  backgroundAdvance?: boolean
}

// ── WorkState 初始化 ────────────────────────────────────────────────

/** 建一個帶預設值的 WorkState；呼叫端（建 job 端點）依抽取結果覆寫欄位並設 phase。 */
export function makeWork(input: PreviewJobInput): WorkState {
  return {
    input,
    phase: 'finalize',
    sourceName: '',
    sourceUrl: '',
    sourceType: input.type,
    rawLength: 0,
    truncated: false,
    meta: {},
    ocrUsed: false,
    ocrPageTotal: 0,
    ocrPageCursor: 0,
    ocrText: '',
    segments: [],
    segmentCursor: 0,
    enrichCursor: 0,
    chunks: [],
    overviewCard: null,
    existingMatches: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    warnings: [],
    suggestedProductName: '',
  }
}

/**
 * 有了純文字（文字層 PDF / url / xlsx 散文 / text）後，準備整理階段。
 * text 已由抽取器截到 MAX_RAW_TEXT_LEN；空字串則直接 finalize（端點回「沒切出卡」）。
 */
export function primeChunking(work: WorkState, text: string): void {
  work.segments = segmentText(text)
  work.segmentCursor = 0
  work.phase = text.trim() && work.segments.length ? 'chunk' : 'finalize'
}

// ── 狀態機：一次推進一個有界單位 ──────────────────────────────────────

/**
 * 推進 job 一步（原地修改並回傳同一個 work）。只處理 ocr / chunk / overview；
 * finalize / done 由端點處理（要碰 db：記帳 + 同名偵測）。
 * deps.getSourceBuffer 只在 ocr 階段會被呼叫（回原始 PDF buffer）。
 */
export async function advanceWork(
  work: WorkState,
  deps: { getSourceBuffer?: () => Promise<Buffer> } = {},
): Promise<WorkState> {
  switch (work.phase) {
    case 'ocr':
      return advanceOcr(work, deps)
    case 'chunk':
      return advanceChunk(work)
    case 'enrich':
      return advanceEnrich(work)
    case 'overview':
      return advanceOverview(work)
    default:
      return work
  }
}

async function advanceOcr(
  work: WorkState,
  deps: { getSourceBuffer?: () => Promise<Buffer> },
): Promise<WorkState> {
  if (!deps.getSourceBuffer) {
    throw createError({ statusCode: 500, statusMessage: 'ocr 階段缺少原始檔' })
  }
  const buffer = await deps.getSourceBuffer()
  const start = work.ocrPageCursor
  const count = Math.min(OCR_PAGE_BATCH, Math.max(0, work.ocrPageTotal - start))
  if (count > 0) {
    const sub = await splitPdfPageRange(buffer, start, count)
    const ocr = await ocrPdfWithGemini(sub)
    if (ocr.text.trim()) work.ocrText += (work.ocrText ? '\n' : '') + ocr.text
    work.usage.inputTokens += ocr.inputTokens
    work.usage.outputTokens += ocr.outputTokens
  }
  work.ocrPageCursor = start + Math.max(1, count) // 保底前進，避免 count=0 時卡死

  if (work.ocrPageCursor >= work.ocrPageTotal) {
    work.ocrUsed = true
    // OCR 跑完卻一個字都沒讀到 → 純圖片且畫質不足 / 非文字內容。給明確可行動的錯誤,
    // 不要默默 finalize 成「0 張卡」讓使用者一頭霧水。
    if (!work.ocrText.trim()) {
      throw createError({
        statusCode: 422,
        statusMessage: '這份 PDF 讀不到任何文字（可能是純圖片且畫質不足，或內容不是文字）；請改貼文字或換一份更清晰的檔案',
      })
    }
    const capped = work.ocrText.slice(0, MAX_RAW_TEXT_LEN)
    work.rawLength = work.ocrText.length
    work.truncated = work.ocrText.length > capped.length
    primeChunking(work, capped)
  }
  return work
}

async function advanceChunk(work: WorkState): Promise<WorkState> {
  const start = work.segmentCursor
  if (work.segments[start] === undefined) {
    work.phase = 'finalize'
    return work
  }

  // 一輪同時切多段:序列版本在長文件上很痛(100k 字 ≈ 13 段 × 每段 15–25 秒 ≈ 5 分鐘,
  // 比改成背景作業之前的並行整理還慢)。並行度沿用 chunker 的保守值,單輪 wall clock
  // ≈ 一次 LLM latency,仍遠低於閘道逾時。
  const batch: Array<{ index: number; text: string }> = []
  for (let i = start; i < work.segments.length && batch.length < CHUNK_CONCURRENCY; i++) {
    batch.push({ index: i, text: work.segments[i]! })
  }

  const total = work.segments.length
  const results = await Promise.allSettled(batch.map(({ index, text }) => {
    const hint = total > 1
      ? `${work.sourceName}（第 ${index + 1}/${total} 段）`.trim()
      : work.sourceName
    return chunkSegment(text, hint)
  }))

  // 先把「所有已完成呼叫」的 token 記起來:Gemini 已經算錢了,不論這批結果後面會不會
  // 因為撞卡片上限、或前面某段要對半切而被丟棄,用量報表都必須看得到。
  for (const r of results) {
    if (r.status === 'fulfilled') {
      work.usage.inputTokens += r.value.inputTokens
      work.usage.outputTokens += r.value.outputTokens
    }
  }

  // 去重的尺與 resync 同一把（normalizeForCompare）：只去空白吃不到「iPhone 保固」vs「IPHONE保固」
  // 這種全半形/大小寫變體——入庫成兩張後，之後每次同步都被誤報 removed（影子卡）
  const seen = new Set(work.chunks.map(c => normalizeForCompare(c.title)))
  let consumed = 0
  for (let b = 0; b < batch.length; b++) {
    const item = batch[b]!
    const r = results[b]!

    if (r.status === 'rejected') {
      // 內容太密、一段切出的卡撞 maxOutputTokens → 輸出 JSON 被截斷。把這段對半切、原地換入、
      // **cursor 停在這一段**,下一輪用更小的段重試(天然可續跑)。
      // 只對「截斷型」錯誤這樣做;其它錯誤(網路 502 等)照丟,避免無限切。
      if (isChunkTruncationError(r.reason) && item.text.length > MIN_SEGMENT_SPLIT_LEN) {
        const parts = splitSegmentInHalf(item.text)
        if (parts.length >= 2) {
          // 先把這一段之前已成功的成果收下(cursor 前進 consumed),再把這段換成兩小段。
          // 這一段之後那些已跑完的結果只好丟掉重跑——截斷很罕見,不值得為它加狀態複雜度;
          // token 已在上面統一入帳,不會漏記。
          work.segments.splice(item.index, 1, ...parts)
          break
        }
      }
      throw r.reason
    }

    for (const c of r.value.chunks) {
      const key = normalizeForCompare(c.title)
      if (seen.has(key)) continue
      seen.add(key)
      work.chunks.push(c)
      if (work.chunks.length >= MAX_TOTAL_CHUNKS) break
    }
    consumed++
    if (work.chunks.length >= MAX_TOTAL_CHUNKS) break
  }

  work.segmentCursor = start + consumed
  if (work.segmentCursor >= work.segments.length || work.chunks.length >= MAX_TOTAL_CHUNKS) {
    // 撞卡數上限要說（C-49B）：10 萬字型錄切到一半就滿 150 張，後面的段整批不處理。
    // 不講的話預覽顯示 150 條、零警告——使用者以為整份都進去了，後半段商品客人一問就答不出來。
    // （gsheet 路徑本來就有「超過 150 列」提示，LLM 路徑漏了這句。）
    if (work.chunks.length >= MAX_TOTAL_CHUNKS && work.segmentCursor < work.segments.length) {
      const skipped = work.segments.length - work.segmentCursor
      work.warnings.push(`內容太多：整理到 ${MAX_TOTAL_CHUNKS} 條上限就停了，後面約 ${skipped} 段（占全文約 ${Math.round(skipped / work.segments.length * 100)}%）沒有處理。建議把文件拆成兩份分批匯入。`)
    }
    work.phase = (work.input.generateOverview && work.chunks.length >= 2) ? 'overview' : 'finalize'
  }
  return work
}

/**
 * 補問法（一列一卡的 gsheet / 乾淨 xlsx）：一輪補一批（≤ ENRICH_BATCH_SIZE 張、一次 LLM 呼叫），
 * 壓在閘道逾時內。只「補」不「改」：不動 title / content（它們是 gsheet 同步的比對基準）。
 * 失敗不擋匯入——卡片沒問法仍可用（只是檢索較弱），跳過該批繼續。
 */
async function advanceEnrich(work: WorkState): Promise<WorkState> {
  const cursor = work.enrichCursor ?? 0
  const batch = work.chunks.slice(cursor, cursor + ENRICH_BATCH_SIZE)
  if (batch.length) {
    try {
      const res = await enrichCardBatch(batch.map(c => ({ title: c.title, content: c.content })))
      work.usage.inputTokens += res.inputTokens
      work.usage.outputTokens += res.outputTokens
      batch.forEach((chunk, i) => {
        const it = res.items[i]
        if (!it) return
        // 商家（或前一階段）已有的問法 / 標籤優先，只補空缺
        if (!chunk.questions?.length) chunk.questions = it.questions
        if (!chunk.tags?.length) chunk.tags = it.tags
      })
    }
    catch (e) {
      console.warn('[preview-jobs] enrich batch failed（該批不補問法，照常繼續）:', e)
      // 「不擋」不等於「不說」（C-49B）：全滅時 150 張卡都沒問法、檢索明顯變弱，
      // 而畫面一路綠——記一筆失敗批數，收尾時警告一次。
      work.enrichFailedBatches = (work.enrichFailedBatches ?? 0) + 1
    }
  }
  work.enrichCursor = cursor + Math.max(1, batch.length) // 保底前進，避免卡死
  if (work.enrichCursor >= work.chunks.length && (work.enrichFailedBatches ?? 0) > 0) {
    work.warnings.push(`有 ${work.enrichFailedBatches} 批卡片沒補到「客人問法」（AI 服務暫時不穩），這些卡照常匯入但檢索效果較弱；稍後可在知識庫按「補問法」重跑。`)
  }

  if (work.enrichCursor >= work.chunks.length) {
    // xlsx（type=file）要總表就接 overview；gsheet 維持不做總表的舊行為
    work.phase = (work.input.generateOverview && work.input.type === 'file' && work.chunks.length >= 2)
      ? 'overview'
      : 'finalize'
  }
  return work
}

async function advanceOverview(work: WorkState): Promise<WorkState> {
  // 總表失敗不擋整理結果（同 preview-chunks 的原行為）
  try {
    const ov = await summarizeAsOverviewCard(work.chunks, { hint: work.sourceName })
    if (ov) {
      work.overviewCard = ov.card
      work.usage.inputTokens += ov.inputTokens
      work.usage.outputTokens += ov.outputTokens
    }
  }
  catch (e) {
    console.warn('[preview-jobs] overview synthesis failed:', e)
  }
  work.phase = 'finalize'
  return work
}

/**
 * 把「還沒入帳的 token」記進用量,並在 work 上標記已入帳到哪。
 *
 * 為什麼要增量結清:job 每推進一步就燒掉真實的 LLM 費用,但使用者可能中途按取消、
 * 或前端輪詢逾時後再也沒人推進這個 job——若只在 finalize 記帳,那些 token 由 Gemini 收錢、
 * 我們的用量報表卻完全看不到(取消鈕上線後這種情況會變常態)。
 * 呼叫端在每次 advanceWork 之後、以及 finalize 收尾時呼叫;保存 work 前呼叫,
 * 讓 usageFlushed 跟著一起存下去(重複呼叫是安全的,差額為 0 就不寫)。
 */
export async function flushJobUsage(workspaceId: string, work: WorkState): Promise<void> {
  const flushed = work.usageFlushed ?? { inputTokens: 0, outputTokens: 0 }
  const inputTokens = work.usage.inputTokens - flushed.inputTokens
  const outputTokens = work.usage.outputTokens - flushed.outputTokens
  if (inputTokens <= 0 && outputTokens <= 0) return
  // 記帳成功才推進水位:先推進再寫入的話,這次寫入失敗(Firestore 短暫不可用)會讓這段用量
  // 永遠沒人記——下一次 flush 只算它之後的差額,正是這個機制要防的「花了錢卻看不到」。
  const snapshot = { inputTokens: work.usage.inputTokens, outputTokens: work.usage.outputTokens }
  try {
    await recordAiUsage(workspaceId, {
      inputTokens,
      outputTokens,
      importInputTokens: inputTokens,
      importOutputTokens: outputTokens,
    })
    work.usageFlushed = snapshot
  }
  catch (e) {
    console.warn('[preview-jobs] flush usage failed（下一輪會連同這次的差額重試）:', e)
  }
}

// ── 進度 / 結果對外形狀 ─────────────────────────────────────────────

export function progressFor(work: WorkState): { done: number; total: number; label: string } {
  switch (work.phase) {
    case 'ocr':
      return { done: work.ocrPageCursor, total: Math.max(1, work.ocrPageTotal), label: '辨識掃描檔' }
    case 'chunk':
      return { done: work.segmentCursor, total: Math.max(1, work.segments.length), label: '整理' }
    case 'enrich':
      return {
        done: Math.min(work.enrichCursor ?? 0, work.chunks.length),
        total: Math.max(1, work.chunks.length),
        label: '補客人問法',
      }
    case 'overview':
      return { done: 0, total: 1, label: '產生總表' }
    case 'finalize':
      return { done: 1, total: 1, label: work.input.resyncSourceId ? '比對新舊差異' : '整理中' }
    case 'done':
      return { done: 1, total: 1, label: '完成' }
    default:
      return { done: 0, total: 1, label: '處理中' }
  }
}

/** done 時回給前端的形狀，與舊 preview-chunks 一致，讓前端映射程式碼原封不動。 */
export function workToPreviewResult(work: WorkState) {
  return {
    sourceName: work.sourceName,
    sourceUrl: work.sourceUrl,
    sourceType: work.sourceType,
    rawLength: work.rawLength,
    truncated: work.truncated,
    meta: work.meta,
    ocrUsed: work.ocrUsed,
    chunks: work.chunks.map(c => ({
      title: c.title,
      content: c.content,
      tags: c.tags,
      questions: c.questions ?? [],
    })),
    overviewCard: work.overviewCard
      ? {
          title: work.overviewCard.title,
          content: work.overviewCard.content,
          tags: work.overviewCard.tags,
          questions: work.overviewCard.questions ?? [],
        }
      : null,
    existingMatches: work.existingMatches,
    usage: work.usage,
    warnings: work.warnings ?? [], // 舊 job 的 work.json 沒這欄位，保底空陣列
    suggestedProductName: work.suggestedProductName ?? '',
    // 網址來源的內容指紋：匯入時原樣回傳給 bulk-create 當「重新同步」的比對基準
    contentHash: work.extractedHash ?? '',
    ...(work.input.resyncSourceId
      ? {
          resync: {
            sourceId: work.input.resyncSourceId,
            contentHash: work.resyncContentHash ?? '',
            diff: work.resyncDiff ?? null,
            shrink: work.resyncShrink ?? null,
          },
        }
      : {}),
  }
}

// ── 匯入品質守門（finalize 時跑；警示不擋匯入）───────────────────────

/**
 * 時效性內容字眼：命中的卡建議設「有效期限」，活動結束自動下架，不會過期照答。
 *
 * ⚠️ 這份清單是從集資／電商案例長出來的（2026-08-11 盤點時定調）：別的行業的時效內容
 * （課程報名截止、門診時段異動）不會命中——後果只是**少一個建議**，不會做錯事，
 * 所以可以接受。⛔ 但別把它升級成會改資料的判斷；要擴大覆蓋，正解是讓切卡 LLM
 * 自己標「這張卡有時效」（它已經在讀內容了），不是往這裡加字。
 */
const TIME_SENSITIVE_RE = /募資|集資|預購|倒數|折扣碼|優惠碼|限時|早鳥|檔期|回饋價/

const normTitle = (s: string) => String(s || '').replace(/\s+/g, '').toLowerCase()

/** 標題視為「幾乎相同」：正規化後相等，或互為包含（較短那個 ≥ 4 字）。與答題端 dedupe 同思路。 */
function titlesNearIdentical(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  return shorter.length >= 4 && longer.includes(shorter)
}

/**
 * 整理完成後的品質守門（P1-2 匯入防護），把警示 push 進 work.warnings：
 * 1. 時效性內容（募資 / 折扣 / 檔期）→ 建議設有效期限。
 * 2. 與現有知識卡標題重複 → 重複匯入提醒（GPLUS 兩本說明書各生一套同樣卡的教訓）。
 * 3. 總表涵蓋率對照產品索引 → 總表宣稱與系統已知產品對不上（「主要產品為X」矛盾偵測）。
 * 4. 多張卡的檔案沒認出產品名 → 說明書漏設產品名提醒（無主卡事故的源頭）。
 * 全部 fail-open：查詢失敗只略過該項檢查，不擋匯入。
 */
export async function appendImportQualityWarnings(
  db: Firestore,
  workspaceId: string,
  work: WorkState,
): Promise<void> {
  // 1. 時效性內容
  const timeSensitiveCount = work.chunks.filter(c =>
    TIME_SENSITIVE_RE.test(c.title) || TIME_SENSITIVE_RE.test(c.content)).length
  if (timeSensitiveCount > 0) {
    work.warnings.push(
      `有 ${timeSensitiveCount} 張卡含有時效性內容（募資 / 折扣 / 檔期）——匯入後建議在卡片編輯視窗設定「有效期限」，活動結束會自動下架，不會過期還照答。`,
    )
  }

  // 2. 與現有卡標題重複（跨來源）
  try {
    const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .select('title')
      .limit(2000)
      .get()
    const existing = snap.docs.map(d => normTitle((d.data() as any)?.title)).filter(Boolean)
    if (existing.length) {
      const dupCount = work.chunks.filter((c) => {
        const t = normTitle(c.title)
        return existing.some(e => titlesNearIdentical(t, e))
      }).length
      if (dupCount >= 3) {
        work.warnings.push(
          `有 ${dupCount} 張卡與現有知識卡的標題相同或幾乎相同——可能是重複匯入（例：同產品兩份說明書）。重複卡會讓 AI 反問時出現兩個一樣的選項，建議先取消勾選重複的，或匯入後整理。`,
        )
      }
    }
  }
  catch (e) {
    console.warn('[preview-jobs] duplicate-title check failed（略過）:', e)
  }

  // 3. 總表 vs 產品索引涵蓋率（只在要合成總表時有意義）
  try {
    if (work.overviewCard) {
      const names = await getWorkspaceProductNames(db, workspaceId)
      if (names.length >= 3) {
        const content = normTitle(work.overviewCard.content)
        const covered = names.filter((n) => {
          const nn = normTitle(n)
          return nn.length >= 3 && content.includes(nn)
        }).length
        if (covered / names.length < 0.3) {
          work.warnings.push(
            `總表只提到系統已知 ${names.length} 項產品中的 ${covered} 項——來源頁面可能沒抓到商品區塊（動態首頁常見）。總表專門回答「你們有賣什麼」，內容錯會整店答錯，請務必確認或改用商品列表頁重新匯入。`,
          )
        }
      }
    }
  }
  catch (e) {
    console.warn('[preview-jobs] overview-coverage check failed（略過）:', e)
  }

  // 4. 多張卡的檔案沒認出產品名（說明書漏設產品名 → 無主卡 → 反問怪按鈕 / 跨產品誤導）
  if (
    work.input.type === 'file'
    && !work.input.generateOverview
    && !work.suggestedProductName
    && work.chunks.length >= 5
  ) {
    work.warnings.push(
      '沒有辨識出這份文件屬於哪個產品——若它其實是單一產品的說明書，請在「所屬產品」欄填入產品名（含品牌與型號），否則客人指名問的時候可能拿別台產品的內容回答。',
    )
  }
}

// ── 同名來源偵測（給前端 dedup 警告；查詢失敗回空陣列）────────────────

export async function findExistingSources(
  workspaceId: string,
  sourceName: string,
  db: Firestore = getDb(),
): Promise<ExistingMatch[]> {
  if (!sourceName) return []
  try {
    const snap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .where('name', '==', sourceName)
      .limit(5)
      .get()
    return snap.docs.map((d) => {
      const data = d.data() as any
      const ts = data?.updatedAt
      const sec = ts?._seconds ?? ts?.seconds
      return {
        id: d.id,
        name: String(data?.name ?? ''),
        chunkCount: Number(data?.chunkCount ?? 0),
        updatedAtMs: typeof sec === 'number' ? sec * 1000 : 0,
      }
    })
  }
  catch (e) {
    console.warn('[preview-jobs] dedup check failed:', e)
    return []
  }
}

// ── Storage IO（work.json + 原始檔）─────────────────────────────────

function jobPrefix(workspaceId: string, jobId: string): string {
  return `preview-jobs/${workspaceId}/${jobId}`
}

/**
 * 存進度。expectedGeneration 有帶＝樂觀鎖（C-46）：work.json 的 GCS generation
 * 與載入時不同（別的執行體已寫過）→ 412，呼叫端放棄這一步的結果。
 * 沒有鎖的年代：兩個執行體交錯寫回會讓 segmentCursor 倒退、已付費切好的段
 * 整批消失重跑、token 重複入帳。回傳這次寫入後的 generation 供下一步續用。
 */
export async function saveWork(
  workspaceId: string,
  jobId: string,
  work: WorkState,
  expectedGeneration?: number,
): Promise<number | undefined> {
  const file = getStorage().bucket().file(`${jobPrefix(workspaceId, jobId)}/work.json`)
  /**
   * ⛔`ifGenerationMatch: 0` 在 GCS 的語意是「這個物件必須**不存在**」——不是「不比對」。
   * 2026-08-19 踩過：generation 讀不到時退回 0，work.json 明明存在 → 每次存檔必 412，
   * 而 412 被呼叫端判成「別人接手了」→ 每輪推進一步、丟掉一步，錢照付、進度永遠不動。
   * 讀不到就**不帶前置條件**（放棄這一步的鎖，回到「後寫的贏」）比帶一個語意相反的值安全。
   */
  await file.save(JSON.stringify(work), {
    contentType: 'application/json',
    ...(expectedGeneration !== undefined && expectedGeneration > 0
      ? { preconditionOpts: { ifGenerationMatch: expectedGeneration } }
      : {}),
  })
  const gen = Number(file.metadata?.generation ?? 0)
  // undefined＝這次拿不到版本號 → 下一步不要鎖（見上面的 0 語意陷阱）
  return gen > 0 ? gen : undefined
}

export async function loadWork(workspaceId: string, jobId: string): Promise<WorkState> {
  const [buf] = await getStorage().bucket()
    .file(`${jobPrefix(workspaceId, jobId)}/work.json`)
    .download()
  return JSON.parse(buf.toString('utf8')) as WorkState
}

/** 載入進度＋generation（配 saveWork 的樂觀鎖用；讀取釘在同一個 generation 上避免讀寫間被換掉） */
export async function loadWorkWithGeneration(
  workspaceId: string,
  jobId: string,
): Promise<{ work: WorkState; generation: number | undefined }> {
  const file = getStorage().bucket().file(`${jobPrefix(workspaceId, jobId)}/work.json`)
  const [meta] = await file.getMetadata()
  const gen = Number(meta.generation ?? 0)
  // undefined＝拿不到版本號，這一輪不上鎖（0 是「必須不存在」，帶下去會永久 412）
  const generation = gen > 0 ? gen : undefined
  const [buf] = await file.download(generation ? ({ generation } as never) : undefined)
  return { work: JSON.parse(buf.toString('utf8')) as WorkState, generation }
}

/** 上傳原始 PDF（掃描檔 OCR 用）。回傳存於 prefix 下的檔名，寫進 job.sourceFile。 */
export async function saveSourceFile(
  workspaceId: string,
  jobId: string,
  buffer: Buffer,
  ext: string,
  contentType: string,
): Promise<string> {
  const name = `source.${ext || 'bin'}`
  await getStorage().bucket()
    .file(`${jobPrefix(workspaceId, jobId)}/${name}`)
    .save(buffer, { contentType: contentType || 'application/octet-stream' })
  return name
}

export async function loadSourceFile(workspaceId: string, jobId: string, name: string): Promise<Buffer> {
  const [buf] = await getStorage().bucket()
    .file(`${jobPrefix(workspaceId, jobId)}/${name}`)
    .download()
  return buf
}

/** 刪掉某 job 的所有 Storage temp（work.json + 原檔）。失敗不擋。 */
export async function deleteJobStorage(workspaceId: string, jobId: string): Promise<void> {
  await getStorage().bucket()
    .deleteFiles({ prefix: `${jobPrefix(workspaceId, jobId)}/` })
    .catch((e) => { console.warn(`[preview-jobs] storage cleanup failed (${jobId}):`, e) })
}

/**
 * 清掉過期 job（Firestore 文件 + Storage temp）。
 *
 * 兩個觸發點：
 * 1) scheduled task（每 15 分；同 retry-stuck-chunks 模式）——本機 dev / 長駐 compute 有效。
 * 2) 建 job 端點的「機會性清掃」（小 limit）——Amplify 上 Nitro scheduledTasks 不會跑，
 *    改綁在功能自身的流量上：只要有人用匯入，就順手掃掉先前過期的 job，無需 cron。
 *
 * 逐 job 的 Storage 刪除並行進行，控制延遲。
 */
export async function cleanupExpiredPreviewJobs(
  db: Firestore = getDb(),
  limit = 200,
): Promise<{ scanned: number; deleted: number; extended: number; failed: number }> {
  const snap = await db.collection(KNOWLEDGE_PREVIEW_JOBS_COLLECTION)
    .where('expiresAt', '<=', Timestamp.now())
    .limit(limit)
    .get()
  let deleted = 0
  let extended = 0
  let failed = 0
  await Promise.all(snap.docs.map(async (doc) => {
    const data = doc.data() as PreviewJobDoc & { updatedAt?: { toMillis?: () => number } }
    // 還在動的 job 不刪、改續命（C-46）：使用者中途去開會/筆電休眠，回來要能接續，
    // 已付的 OCR 錢不作廢。「還在動」= 30 分鐘內有寫入過（每一步都會戳 updatedAt）。
    const updatedMs = typeof data.updatedAt?.toMillis === 'function' ? data.updatedAt.toMillis() : 0
    if (data.status === 'processing' && updatedMs > Date.now() - 30 * 60_000) {
      await doc.ref.update({ expiresAt: Timestamp.fromMillis(Date.now() + JOB_TTL_MS) })
        .then(() => { extended++ })
        .catch(() => { failed++ })
      return
    }
    // 照實計數——「deleted 恆等於 scanned」的假回報是健檢明列的反模式
    try {
      await deleteJobStorage(data.workspaceId, doc.id)
      await doc.ref.delete()
      deleted++
    }
    catch (e) {
      failed++
      console.warn(`[cleanup-preview-jobs] ${doc.id} delete failed:`, e)
    }
  }))

  return { scanned: snap.size, deleted, extended, failed }
}

/**
 * 清 preview-uploads/ 的孤兒上傳檔（C-49E）：使用者選了檔、上傳到一半按取消
 * （最常見的操作）那顆檔永遠沒人刪——唯一的刪除點在 preview-jobs 端點被呼叫到時。
 * 超過 24 小時的一律清（正常流程上傳後幾秒內就被消費掉）。
 *
 * ⛔**只給排程呼叫,不要塞進使用者請求**:列舉 + 逐檔刪除最壞是一次 list 加數百次
 * 往返,掛在「建立匯入工作」那種本來就逼近閘道逾時的端點上會讓它直接超時。
 * 每輪限量刪，剩下的下一輪繼續（10 分鐘一輪，追得上任何正常累積速度）。
 */
export async function cleanupOrphanUploads(
  maxDeletes = 50,
): Promise<{ scanned: number; purged: number }> {
  let purged = 0
  let scanned = 0
  try {
    const [files] = await getStorage().bucket().getFiles({ prefix: 'preview-uploads/', maxResults: 300 })
    scanned = files.length
    const cutoff = Date.now() - 24 * 3600_000
    for (const f of files) {
      if (purged >= maxDeletes) break
      const createdMs = Date.parse(String(f.metadata?.timeCreated ?? '')) || 0
      if (createdMs && createdMs < cutoff) {
        await f.delete().then(() => { purged++ }).catch(() => {})
      }
    }
  }
  catch (e) {
    console.warn('[cleanup-orphan-uploads] sweep failed:', e)
  }
  return { scanned, purged }
}
