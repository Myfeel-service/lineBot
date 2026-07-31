/**
 * 知識庫「上傳預覽」的非同步 job + 輪詢狀態機。
 *
 * 為什麼要這個：preview-chunks 是同步 API，一個請求裡把「抽文字 → LLM 切卡（+OCR
 * +總覽卡）」整包做完；長 PDF 會超過 Amplify/CloudFront 的閘道逾時（~30s）→ 504。
 *
 * 設計（順這個 codebase 的既有紋理：每個請求壓在時限內、溢出排 Firestore）：
 * - 建 job 時把「快且會報錯」的抽取先做掉（讓壞檔/加密當場報錯），重活留給輪詢。
 * - 前端每 ~2s 輪詢一次，每次 advanceWork **只推進一個有界單位**（一批 OCR 頁 / 一段切卡 /
 *   一次總覽卡），每步都壓在逾時內 → 永不 504。
 * - 大文字放 Storage 的 work.json（無 1 MiB 限制）；Firestore job 文件只留狀態/進度/lease。
 * - lease + cursor 讓中途被閘道掐斷的一步能在 lease 過期後被下一輪重跑，不重跑已完成的步。
 */
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { getDb, getStorage } from './firebase'
import {
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
import type { ChunkInput } from './ai-knowledge-chunks'

export const KNOWLEDGE_PREVIEW_JOBS_COLLECTION = 'knowledgePreviewJobs'

/** 單批 OCR 的頁數：壓在閘道逾時內，同時控制 job 步數。5 頁 ≈ 15–25s。 */
export const OCR_PAGE_BATCH = 5

/** 切卡撞輸出上限時「對半再切」的下限；小於此就不再切（真的還失敗代表非截斷問題）。 */
export const MIN_SEGMENT_SPLIT_LEN = 1500

/** claim 一步的租約時間；poll 中途被閘道 504，過了這段時間下一輪可重接。 */
export const JOB_LEASE_MS = 45_000

/** job 存活時間；超過由 cleanup task 連同 Storage temp 一起刪。 */
export const JOB_TTL_MS = 60 * 60 * 1000

export type PreviewJobStatus = 'processing' | 'done' | 'error'
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
  // 切卡進度
  segments: string[]
  segmentCursor: number
  // 補問法進度（gsheet / 乾淨 xlsx 的一列一卡：卡片沒有 questions，逐批補）
  enrichCursor: number
  // 累積產出
  chunks: ChunkInput[]
  overviewCard: ChunkInput | null
  existingMatches: ExistingMatch[]
  usage: { inputTokens: number; outputTokens: number }
  /** 匯入前健檢警告（表格來源：示範列沒換、重複問題、合併儲存格等）；提醒不擋匯入 */
  warnings: string[]
  /** 自動偵測的產品名（finalize 時 LLM 判定；多產品 / 平台頁為空）。預填給使用者確認可改。 */
  suggestedProductName?: string
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
 * 有了純文字（文字層 PDF / url / xlsx 散文 / text）後，準備切卡階段。
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
  const i = work.segmentCursor
  const seg = work.segments[i]
  if (seg === undefined) {
    work.phase = 'finalize'
    return work
  }
  const hint = work.segments.length > 1
    ? `${work.sourceName}（第 ${i + 1}/${work.segments.length} 段）`.trim()
    : work.sourceName

  let res: Awaited<ReturnType<typeof chunkSegment>>
  try {
    res = await chunkSegment(seg, hint)
  }
  catch (err) {
    // 內容太密、一段切出的卡撞 maxOutputTokens → 輸出 JSON 被截斷。把這段對半切、原地換入、
    // **不進 cursor**，下一輪用更小的段重試（天然可續跑，一個 poll 仍只打一次 LLM）。
    // 只對「截斷型」錯誤這樣做；其它錯誤（網路 502 等）照丟，避免無限切。
    if (isChunkTruncationError(err) && seg.length > MIN_SEGMENT_SPLIT_LEN) {
      const parts = splitSegmentInHalf(seg)
      if (parts.length >= 2) {
        work.segments.splice(i, 1, ...parts)
        return work
      }
    }
    throw err
  }
  work.usage.inputTokens += res.inputTokens
  work.usage.outputTokens += res.outputTokens

  const seen = new Set(work.chunks.map(c => c.title.replace(/\s+/g, '')))
  for (const c of res.chunks) {
    const key = c.title.replace(/\s+/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    work.chunks.push(c)
    if (work.chunks.length >= MAX_TOTAL_CHUNKS) break
  }

  work.segmentCursor = i + 1
  if (work.segmentCursor >= work.segments.length || work.chunks.length >= MAX_TOTAL_CHUNKS) {
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
    }
  }
  work.enrichCursor = cursor + Math.max(1, batch.length) // 保底前進，避免卡死

  if (work.enrichCursor >= work.chunks.length) {
    // xlsx（type=file）要總覽卡就接 overview；gsheet 維持不做總覽卡的舊行為
    work.phase = (work.input.generateOverview && work.input.type === 'file' && work.chunks.length >= 2)
      ? 'overview'
      : 'finalize'
  }
  return work
}

async function advanceOverview(work: WorkState): Promise<WorkState> {
  // 總覽卡失敗不擋切卡結果（同 preview-chunks 的原行為）
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

// ── 進度 / 結果對外形狀 ─────────────────────────────────────────────

export function progressFor(work: WorkState): { done: number; total: number; label: string } {
  switch (work.phase) {
    case 'ocr':
      return { done: work.ocrPageCursor, total: Math.max(1, work.ocrPageTotal), label: '辨識掃描檔' }
    case 'chunk':
      return { done: work.segmentCursor, total: Math.max(1, work.segments.length), label: '切卡' }
    case 'enrich':
      return {
        done: Math.min(work.enrichCursor ?? 0, work.chunks.length),
        total: Math.max(1, work.chunks.length),
        label: '補客人問法',
      }
    case 'overview':
      return { done: 0, total: 1, label: '產生總覽卡' }
    case 'finalize':
      return { done: 1, total: 1, label: '整理中' }
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
  }
}

// ── 匯入品質守門（finalize 時跑；警示不擋匯入）───────────────────────

/** 時效性內容字眼：命中的卡建議設「有效期限」，活動結束自動下架，不會過期照答 */
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
 * 切卡完成後的品質守門（P1-2 匯入防護），把警示 push 進 work.warnings：
 * 1. 時效性內容（募資 / 折扣 / 檔期）→ 建議設有效期限。
 * 2. 與現有知識卡標題重複 → 重複匯入提醒（GPLUS 兩本說明書各生一套同樣卡的教訓）。
 * 3. 總覽卡涵蓋率對照產品索引 → 總覽卡宣稱與系統已知產品對不上（「主要產品為X」矛盾偵測）。
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

  // 3. 總覽卡 vs 產品索引涵蓋率（只在要合成總覽卡時有意義）
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
            `總覽卡只提到系統已知 ${names.length} 項產品中的 ${covered} 項——來源頁面可能沒抓到商品區塊（動態首頁常見）。總覽卡專門回答「你們有賣什麼」，內容錯會整店答錯，請務必確認或改用商品列表頁重新匯入。`,
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

export async function saveWork(workspaceId: string, jobId: string, work: WorkState): Promise<void> {
  await getStorage().bucket()
    .file(`${jobPrefix(workspaceId, jobId)}/work.json`)
    .save(JSON.stringify(work), { contentType: 'application/json' })
}

export async function loadWork(workspaceId: string, jobId: string): Promise<WorkState> {
  const [buf] = await getStorage().bucket()
    .file(`${jobPrefix(workspaceId, jobId)}/work.json`)
    .download()
  return JSON.parse(buf.toString('utf8')) as WorkState
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
    .catch(() => {})
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
): Promise<{ scanned: number; deleted: number }> {
  const snap = await db.collection(KNOWLEDGE_PREVIEW_JOBS_COLLECTION)
    .where('expiresAt', '<=', Timestamp.now())
    .limit(limit)
    .get()
  await Promise.all(snap.docs.map(async (doc) => {
    const data = doc.data() as PreviewJobDoc
    await deleteJobStorage(data.workspaceId, doc.id)
    await doc.ref.delete().catch(() => {})
  }))
  return { scanned: snap.size, deleted: snap.size }
}
