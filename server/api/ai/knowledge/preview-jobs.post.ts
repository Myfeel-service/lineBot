import { createHash } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { findSourceByContentHash } from '~~/server/utils/ai-knowledge-sources'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
import { getDb, getStorage } from '~~/server/utils/firebase'
import {
  extractionQualityWarnings,
  extractPdfText,
  extractUrlText,
  extractXlsxCards,
  extractXlsxText,
  isProbablyScannedPdf,
  MAX_OCR_PAGES,
  MAX_RAW_TEXT_LEN,
} from '~~/server/utils/ai-source-extractors'
import { parseGoogleSheetUrl, readGoogleSheetAsCards, sheetHealthWarnings } from '~~/server/utils/google-sheets'
import { getPdfPageCount } from '~~/server/utils/pdf-split'
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
  // 維運額度前置檢查（C-45）：超額就別建工作，讓人第一時間看到原因
  await assertMaintenanceBudget(workspaceId)
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
  // ⛔fire-and-forget、**不 await**：這支端點本來就逼近閘道逾時（抽取＋OCR 判定），
  // 把清掃的 Storage 往返算進回應時間會讓「建立匯入工作」自己超時、連 jobId 都拿不到。
  // 清不完下一輪（或排程的 ai:cleanup-*）會接手。
  void cleanupExpiredPreviewJobs(getDb(), 20).catch(() => {})

  const jobId = uuidv4()
  const work = makeWork(input)
  let sourceFile: string | null = null

  /**
   * 「這份東西已經匯進來過了」的攔截（`C-134`）。
   *
   * 擺在**抽取與整理之前**才有意義：真正的錢花在 OCR ＋ LLM 切卡 ＋ embedding，
   * 等切完再說「其實重複了」等於白花一次（`C-12` 記的就是這筆）。
   * 回 200 帶 `duplicate`（不是丟錯）——使用者要的是兩條路：去看既有那份，或
   * 明知重複仍要再整理一次（`ignoreDuplicate`）。丟錯只會變成死路。
   */
  const ignoreDuplicate = body?.ignoreDuplicate === true
  async function duplicateOf(hash: string, sourceType: 'file' | 'url' | 'text') {
    if (ignoreDuplicate || !hash) return null
    // text 存進 Firestore 時是 type='manual'（見 bulk-create 的說明），比對要照存進去的樣子
    const hit = await findSourceByContentHash(getDb(), workspaceId, hash, sourceType === 'text' ? 'manual' : sourceType)
    return hit ? { duplicate: hit } : null
  }

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

    /**
     * 檔案的指紋算**原始 bytes**，不是抽出來的文字：
     * ① 掃描檔還沒 OCR 就沒有文字可算，而掃描檔正是最貴的那一種，最需要提早擋；
     * ② 「同一份檔案又傳一次」本來就是 bytes 相同，這是最直接的判準。
     * 代價是同一份內容重新匯出成 PDF 會判不出重複——那種情況本來就該重新整理。
     */
    work.extractedHash = createHash('sha256').update(new Uint8Array(buffer)).digest('hex')
    const dup = await duplicateOf(work.extractedHash, 'file')
    if (dup) return dup

    work.sourceName = fileName
    work.sourceType = 'file'
    const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
    const isPdf = contentType.includes('pdf') || ext === 'pdf'
    const isXlsx = contentType.includes('spreadsheet') || contentType.includes('excel') || ext === 'xlsx' || ext === 'xls'

    if (isPdf) {
      const extracted = await extractPdfText(buffer)
      if (isProbablyScannedPdf(extracted, buffer.length)) {
        // 掃描檔：沒有文字層 → 走 OCR 切頁批處理（逐輪推進）。原檔存 Storage 供各批切頁。
        // 頁數讀不到要有第二意見（C-49B）：unpdf 對非標準 PDF 常回不出 totalPages，
        // 原本直接當 1 頁 → 40 頁說明書只辨識第一頁、顯示「整理好了，2 條」——
        // 使用者以為內容就這麼少，後面 39 頁的保固規格全沒進知識庫。
        let pages = Number(extracted.meta.pages ?? 0)
        if (pages <= 0) {
          pages = await getPdfPageCount(buffer).catch(() => 0)
        }
        if (pages <= 0) {
          // 兩邊都讀不到＝檔案結構特殊，猜 1 頁是靜默丟內容——老實報錯讓人換路
          throw createError({ statusCode: 422, statusMessage: '無法判讀這份 PDF 的頁數（檔案格式特殊），AI 辨識無法保證完整；請改貼文字或換一份檔案' })
        }
        if (pages > MAX_OCR_PAGES) {
          throw createError({
            statusCode: 400,
            statusMessage: `這份 PDF 是掃描檔（無文字層、共 ${pages} 頁），AI 辨識目前支援 ${MAX_OCR_PAGES} 頁以內；請拆分檔案或改貼文字`,
          })
        }
        sourceFile = await saveSourceFile(workspaceId, jobId, buffer, ext || 'pdf', contentType || 'application/pdf')
        work.meta = { ...extracted.meta, pages }
        work.ocrPageTotal = pages
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
    // 指紋在這裡就算好隨結果回前端：匯入完存成 source.appliedContentHash，
    // 之後「重新同步」才能直接回答「網頁跟你上次整理時比有沒有變」。
    work.extractedHash = createHash('sha256').update(extracted.text).digest('hex')
    const dupUrl = await duplicateOf(work.extractedHash, 'url')
    if (dupUrl) return dupUrl
    setChunkingFromExtracted(work, extracted)
  }
  else if (type === 'text') {
    const text = String(body?.text ?? '').trim()
    if (!text) throw createError({ statusCode: 400, statusMessage: '請輸入要整理的文字' })
    if (text.length > MAX_RAW_TEXT_LEN) throw createError({ statusCode: 400, statusMessage: `文字超過 ${MAX_RAW_TEXT_LEN} 字上限` })
    work.sourceName = String(body?.name ?? '手打輸入').trim()
    work.sourceType = 'text'
    work.rawLength = text.length
    // 貼上的文字：空白差異不算改動（同一段話重貼一次常常多／少一個換行）
    work.extractedHash = createHash('sha256').update(text.replace(/\s+/g, ' ')).digest('hex')
    const dupText = await duplicateOf(work.extractedHash, 'text')
    if (dupText) return dupText
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
    // 只有單筆匯入會帶 true（見 PreviewJobDoc.backgroundAdvance 的說明）：
    // 整站匯入的每一頁與重新同步都不帶，人一走就不該再花錢推進。
    backgroundAdvance: body?.backgroundAdvance === true,
    createdAt: now,
    updatedAt: now,
    expiresAt: Timestamp.fromMillis(Date.now() + JOB_TTL_MS),
  }
  await getDb().collection(KNOWLEDGE_PREVIEW_JOBS_COLLECTION).doc(jobId).set(jobDoc)

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
    // 先看 metadata 再下載（C-49A）：簽名網址已有大小上限，這裡是第二道——
    // 超大檔要在「下載進記憶體之前」擋下，OOM 炸掉的話連刪檔的機會都沒有
    const [meta] = await file.getMetadata()
    if (Number(meta.size ?? 0) > 10 * 1024 * 1024) {
      await file.delete().catch(() => {})
      throw createError({ statusCode: 400, statusMessage: '檔案超過 10MB 上限' })
    }
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
  extracted: { text: string; rawLength: number; meta: Record<string, string | number>; truncatedBySize?: boolean },
): void {
  if (!extracted.text.trim()) {
    throw createError({ statusCode: 400, statusMessage: '抽出純文字後為空；請確認檔案或連結內容' })
  }
  work.rawLength = extracted.rawLength
  work.truncated = extracted.rawLength > extracted.text.length
  work.meta = extracted.meta
  work.warnings.push(...extractionQualityWarnings(work.sourceType, extracted.text, extracted.truncatedBySize === true))
  primeChunking(work, extracted.text)
}
