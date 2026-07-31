import { v4 as uuidv4 } from 'uuid'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getDb, getStorage } from '~~/server/utils/firebase'
import {
  extractPdfText,
  extractUrlText,
  extractXlsxCards,
  extractXlsxText,
  isProbablyScannedPdf,
  MAX_OCR_PAGES,
  MAX_RAW_TEXT_LEN,
} from '~~/server/utils/ai-source-extractors'
import { parseGoogleSheetUrl, readGoogleSheetAsCards, sheetHealthWarnings } from '~~/server/utils/google-sheets'
import {
  cleanupExpiredPreviewJobs,
  JOB_TTL_MS,
  KNOWLEDGE_PREVIEW_JOBS_COLLECTION,
  makeWork,
  primeChunking,
  progressFor,
  saveSourceFile,
  saveWork,
  type PreviewJobDoc,
  type PreviewJobInput,
  type WorkState,
} from '~~/server/utils/ai-preview-jobs'
import type { ChunkInput } from '~~/server/utils/ai-knowledge-chunks'

/**
 * POST /api/ai/knowledge/preview-jobs
 * Body 同舊 preview-chunks：{ type: 'file'|'url'|'text'|'gsheet', ... , generateOverview }
 *
 * 建一個非同步預覽 job：這裡只做「快且會報錯」的抽取（讓壞檔/加密當場報錯），
 * LLM 切卡 / OCR / 總覽卡等重活留給輪詢端點逐步推進 → 永不 504。
 * 回 { jobId, status, phase }。前端拿 jobId 去輪詢 GET /preview-jobs/[jobId]。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)
  const type = String(body?.type ?? '').trim()
  const wantOverview = body?.generateOverview === true

  const input: PreviewJobInput = {
    type: type as PreviewJobInput['type'],
    fileName: String(body?.fileName ?? '').trim() || undefined,
    contentType: String(body?.contentType ?? '').trim() || undefined,
    url: String(body?.url ?? '').trim() || undefined,
    text: typeof body?.text === 'string' ? body.text : undefined,
    name: String(body?.name ?? '').trim() || undefined,
    generateOverview: wantOverview,
  }

  // 機會性清掃：Amplify 上 scheduledTasks 不會跑，改綁在匯入流量上順手清過期 job。
  // 與底下的抽取重疊進行（最後才 await），幾乎不增加回應延遲；失敗不擋建立。
  const sweep = cleanupExpiredPreviewJobs(getDb(), 20).catch(() => {})

  const jobId = uuidv4()
  const work = makeWork(input)
  let sourceFile: string | null = null

  if (type === 'gsheet') {
    const url = String(body?.url ?? '').trim()
    const ref = parseGoogleSheetUrl(url)
    if (!ref) throw createError({ statusCode: 400, statusMessage: '請貼有效的 Google Sheet 連結或試算表 ID' })
    const sheet = await readGoogleSheetAsCards(ref)
    work.sourceName = `Google Sheet（${sheet.sheetTitle}）`
    work.sourceUrl = url
    work.sourceType = 'gsheet'
    work.truncated = sheet.stats.truncatedByCap
    work.meta = { rows: sheet.stats.rowCount, sheet: sheet.sheetTitle }
    work.chunks = sheet.cards.map(c => cardToChunk(c))
    work.warnings = sheetHealthWarnings(sheet.cards, sheet.stats, sheet.mergeCount)
    // 一列一卡不走 LLM 切卡，但卡片沒有 questions（客人問法）→ 進 enrich 逐批補
    // （只補不改；gsheet 不做總覽卡，enrich 完直接 finalize）
    work.phase = work.chunks.length ? 'enrich' : 'finalize'
  }
  else if (type === 'file') {
    const fileName = String(body?.fileName ?? '').trim()
    const contentType = String(body?.contentType ?? '').trim().toLowerCase()
    if (!fileName) throw createError({ statusCode: 400, statusMessage: '請提供 fileName' })
    // 新路徑：瀏覽器已把原檔直傳 Storage（繞過 Lambda 6MB payload 上限），這裡只收 storagePath 下載 buffer。
    // 舊路徑：相容小檔的 fileBase64 直傳。
    const buffer = await readUploadedFileBuffer(body, workspaceId)
    if (buffer.length === 0) throw createError({ statusCode: 400, statusMessage: '檔案內容為空' })
    if (buffer.length > 10 * 1024 * 1024) throw createError({ statusCode: 400, statusMessage: '檔案超過 10MB 上限' })

    work.sourceName = fileName
    work.sourceType = 'file'
    const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
    const isPdf = contentType.includes('pdf') || ext === 'pdf'
    const isXlsx = contentType.includes('spreadsheet') || contentType.includes('excel') || ext === 'xlsx' || ext === 'xls'

    if (isPdf) {
      const extracted = await extractPdfText(buffer)
      if (isProbablyScannedPdf(extracted, buffer.length)) {
        // 掃描檔：沒有文字層 → 走 OCR 切頁批處理（逐輪推進）。原檔存 Storage 供各批切頁。
        const pages = Number(extracted.meta.pages ?? 0)
        if (pages > MAX_OCR_PAGES) {
          throw createError({
            statusCode: 400,
            statusMessage: `這份 PDF 是掃描檔（無文字層、共 ${pages} 頁），AI 辨識目前支援 ${MAX_OCR_PAGES} 頁以內；請拆分檔案或改貼文字`,
          })
        }
        sourceFile = await saveSourceFile(workspaceId, jobId, buffer, ext || 'pdf', contentType || 'application/pdf')
        work.meta = { ...extracted.meta }
        work.ocrPageTotal = pages > 0 ? pages : 1
        work.ocrPageCursor = 0
        work.phase = 'ocr'
      }
      else {
        setChunkingFromExtracted(work, extracted)
      }
    }
    else if (isXlsx) {
      const xlsx = extractXlsxCards(buffer)
      if (xlsx) {
        // 乾淨表格 → 一列一卡，不走 LLM 切卡；先進 enrich 逐批補 questions（只補不改），
        // 補完由狀態機決定要不要接 overview（wantOverview 且 ≥2 張）。
        work.truncated = xlsx.stats.truncatedByCap
        work.meta = { rows: xlsx.stats.rowCount, sheets: xlsx.sheetCount }
        work.chunks = xlsx.cards.map(c => cardToChunk(c))
        work.warnings = sheetHealthWarnings(xlsx.cards, xlsx.stats, xlsx.mergeCount)
        work.phase = 'enrich'
      }
      else {
        setChunkingFromExtracted(work, extractXlsxText(buffer))
      }
    }
    else {
      throw createError({ statusCode: 400, statusMessage: `不支援的檔案類型：${ext || contentType}` })
    }
  }
  else if (type === 'url') {
    const url = String(body?.url ?? '').trim()
    if (!url) throw createError({ statusCode: 400, statusMessage: '請輸入網址' })
    const extracted = await extractUrlText(url)
    work.sourceName = url
    work.sourceUrl = url
    work.sourceType = 'url'
    setChunkingFromExtracted(work, extracted)
  }
  else if (type === 'text') {
    const text = String(body?.text ?? '').trim()
    if (!text) throw createError({ statusCode: 400, statusMessage: '請輸入要切片的文字' })
    if (text.length > MAX_RAW_TEXT_LEN) throw createError({ statusCode: 400, statusMessage: `文字超過 ${MAX_RAW_TEXT_LEN} 字上限` })
    work.sourceName = String(body?.name ?? '手打輸入').trim()
    work.sourceType = 'text'
    work.rawLength = text.length
    primeChunking(work, text)
  }
  else {
    throw createError({ statusCode: 400, statusMessage: '請指定 type: file / url / text / gsheet' })
  }

  await saveWork(workspaceId, jobId, work)

  const now = FieldValue.serverTimestamp()
  const jobDoc: PreviewJobDoc & Record<string, unknown> = {
    workspaceId,
    createdBy: uid,
    status: 'processing',
    phase: work.phase,
    progress: progressFor(work),
    error: null,
    sourceFile,
    leaseUntil: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: Timestamp.fromMillis(Date.now() + JOB_TTL_MS),
  }
  await getDb().collection(KNOWLEDGE_PREVIEW_JOBS_COLLECTION).doc(jobId).set(jobDoc)

  await sweep // 讓機會性清掃在回應前完成（已與抽取重疊，額外延遲極小）
  return { jobId, status: 'processing' as const, phase: work.phase }
})

/**
 * 取得上傳檔的 bytes：優先用 storagePath（瀏覽器直傳 Storage，繞過 Lambda 6MB payload 上限），
 * 沒有才退回 fileBase64（相容小檔）。storagePath 一律限定在本 workspace 的 preview-uploads/ 底下
 * （防跨租戶 / 讀任意物件），讀完即刪避免累積 temp。
 */
async function readUploadedFileBuffer(
  body: Record<string, unknown>,
  workspaceId: string,
): Promise<Buffer> {
  const storagePath = String(body?.storagePath ?? '').trim()
  if (storagePath) {
    const prefix = `preview-uploads/${workspaceId}/`
    if (!storagePath.startsWith(prefix) || storagePath.includes('..')) {
      throw createError({ statusCode: 400, statusMessage: '無效的 storagePath' })
    }
    const file = getStorage().bucket().file(storagePath)
    const [exists] = await file.exists()
    if (!exists) throw createError({ statusCode: 400, statusMessage: '找不到已上傳的檔案，請重新上傳' })
    const [buf] = await file.download()
    await file.delete().catch(() => {}) // 讀完即刪；失敗不擋建立
    return buf
  }
  const base64 = String(body?.fileBase64 ?? '').trim()
  if (!base64) throw createError({ statusCode: 400, statusMessage: '請提供 storagePath 或 fileBase64' })
  return Buffer.from(base64, 'base64')
}

/** SheetCard / xlsx card → ChunkInput（一列一卡沒有 questions） */
function cardToChunk(c: { title: string; content: string; tags: string[] }): ChunkInput {
  return { title: c.title, content: c.content, tags: c.tags, questions: [], sourceId: null }
}

/** 有純文字的抽取結果 → 設定切卡階段。空文字直接報錯（即時回饋，不用等輪詢）。 */
function setChunkingFromExtracted(
  work: WorkState,
  extracted: { text: string; rawLength: number; meta: Record<string, string | number> },
): void {
  if (!extracted.text.trim()) {
    throw createError({ statusCode: 400, statusMessage: '抽出純文字後為空；請確認檔案或連結內容' })
  }
  work.rawLength = extracted.rawLength
  work.truncated = extracted.rawLength > extracted.text.length
  work.meta = extracted.meta
  work.warnings.push(...extractionQualityWarnings(work.sourceType, extracted.text))
  primeChunking(work, extracted.text)
}

/**
 * 擷取層品質守門（匯入防護）：內容太薄 / 疑似只抓到選單頁尾 → 預覽頁警示，不擋匯入。
 * 7/31 總覽卡事故的根源就是動態首頁只抓到頁腳、切出 11 張平台雜卡而**無任何警示**。
 */
function extractionQualityWarnings(sourceType: string, text: string): string[] {
  const warnings: string[] = []
  const len = text.trim().length
  if (len > 0 && len < 300) {
    warnings.push(sourceType === 'url'
      ? `這個網址只擷取到約 ${len} 字——很可能是動態網頁（內容由程式載入），伺服器抓不到主要內容。建議改用靜態的商品列表頁網址，或直接複製頁面文字用「貼上文字」匯入。`
      : `只擷取到約 ${len} 字，內容可能不完整；請在下一步逐張確認卡片內容。`)
  }
  else if (sourceType === 'url') {
    // 連結密度過高 = 內文多半是選單 / 頁尾（stripHtml 會把站內連結轉成「錨文字（網址）」）
    const linkCount = (text.match(/https?:\/\//g) ?? []).length
    if (linkCount >= 5 && len / linkCount < 80) {
      warnings.push('擷取到的內容大多是連結（可能只抓到選單和頁尾、沒抓到主要內容）——若下一步的卡片沒有實質商品內容，請改用商品列表頁網址或直接貼文字。')
    }
  }
  return warnings
}
