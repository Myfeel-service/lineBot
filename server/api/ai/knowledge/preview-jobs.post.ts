import { createHash } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { findSourceByContentHash } from '~~/server/utils/ai-knowledge-sources'
import { assertMaintenanceBudget } from '~~/server/utils/ai-usage'
import { getDb, getStorage } from '~~/server/utils/firebase'
import {
  extractionQualityWarnings,
  extractOfficeText,
  extractPdfText,
  extractUrlText,
  extractXlsxCards,
  extractXlsxText,
  IMAGE_MIME_BY_EXT,
  isProbablyScannedPdf,
  MAX_OCR_PAGES,
  MAX_RAW_TEXT_LEN,
} from '~~/server/utils/ai-source-extractors'
import { decodeTextBuffer } from '~~/server/utils/office-extractors'
import { KNOWLEDGE_FILE_MAX_BYTES, resolveKnowledgeFile, unsupportedFileHint } from '~~/shared/knowledge-file-types'
import { parseGoogleSheetUrl, readGoogleSheetAsCards, sheetHealthWarnings } from '~~/server/utils/google-sheets'
import { getPdfPageCount } from '~~/server/utils/pdf-split'
import {
  cleanupExpiredPreviewJobs,
  deleteJobStorage,
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
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
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
    // ⛔ 不把「超過 150 列」記成 truncated：畫面看到 truncated 會講「原文超過 10 萬字已截斷」，
    //    跟旁邊那句正確的「只會匯入前 150 列」互相矛盾。列數上限由 sheetHealthWarnings 講。
    work.truncated = false
    work.meta = { rows: sheet.stats.rowCount, sheet: sheet.sheetTitle }
    work.chunks = sheet.cards.map(c => cardToChunk(c))
    work.warnings = [
      ...sheetHealthWarnings(sheet.cards, sheet.stats, sheet.mergeCount),
      ...sheetCoverageWarnings(sheet.skippedSheets, sheet.emptySheets),
    ]
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
    if (buffer.length > KNOWLEDGE_FILE_MAX_BYTES) throw createError({ statusCode: 400, statusMessage: '檔案超過 10MB 上限' })

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
    // 收哪些檔與前端、簽名網址共用 shared/knowledge-file-types（`C-296`）。
    // 有副檔名只看副檔名；沒有副檔名才看瀏覽器給的型別、而且要一模一樣（見 resolveKnowledgeFile）。
    const resolved = resolveKnowledgeFile(fileName, contentType)
    if (!resolved) throw createError({ statusCode: 400, statusMessage: unsupportedFileHint(fileName) })
    // 存原檔用的副檔名與型別一律從我們自己的表來：⛔ 不用瀏覽器給的（那是前端自己填的字串），
    // 沒有副檔名、靠型別認出來的也補上副檔名，下載下來才打得開
    const { kind, ext: storeExt, mime: storeMime } = resolved

    // 純文字類（.txt／.md／.csv）的編碼在這裡自己判一次：文字檔、CSV 一列一卡、CSV 退回 AI 整理
    // 三條路的抽取結果帶的編碼資訊不一樣多，警告要三條路講同一套話，就從同一個來源拿
    const decoded = kind === 'text' || kind === 'csv'
      ? await readingFile(fileName, () => decodeTextBuffer(buffer))
      : null

    try {
      if (kind === 'pdf') {
        const extracted = await readingFile(fileName, () => extractPdfText(buffer))
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
          sourceFile = await saveSourceFile(workspaceId, jobId, buffer, storeExt, storeMime)
          work.meta = { ...extracted.meta, pages }
          work.ocrPageTotal = pages
          work.ocrPageCursor = 0
          work.phase = 'ocr'
        }
        else {
          setChunkingFromExtracted(work, extracted)
        }
      }
      else if (kind === 'xlsx' || kind === 'csv') {
        const xlsx = await readingFile(fileName, () => extractXlsxCards(buffer, kind))
        if (xlsx) {
          // 乾淨表格 → 一列一卡，不走 LLM 切卡；先進 enrich 逐批補 questions（只補不改），
          // 補完由狀態機決定要不要接 overview（wantOverview 且 ≥2 張）。
          // ⛔ 不把「超過 150 列」記成 truncated：畫面看到 truncated 會講「原文超過 10 萬字已截斷」，
          //    跟 sheetHealthWarnings 那句正確的「只會匯入前 150 列」互相矛盾（一列一卡沒有字數上限）
          work.truncated = false
          work.meta = { rows: xlsx.stats.rowCount, sheets: xlsx.sheetCount, ...(xlsx.encoding ? { encoding: xlsx.encoding } : {}) }
          work.chunks = xlsx.cards.map(c => cardToChunk(c))
          work.warnings = [
            ...sheetHealthWarnings(xlsx.cards, xlsx.stats, xlsx.mergeCount),
            ...sheetCoverageWarnings(xlsx.skippedSheets, xlsx.emptySheets),
          ]
          work.phase = 'enrich'
        }
        else {
          setChunkingFromExtracted(work, await readingFile(fileName, () => extractXlsxText(buffer, kind)))
        }
      }
      else if (kind === 'image') {
        // 照片（價目表、菜單、DM）：跟掃描 PDF 走同一條認字的路，只是一次一張。
        // 認字要十幾秒，⛔ 不在這個請求裡做（建工作端點本來就逼近閘道逾時）——交給輪詢推進。
        const mime = IMAGE_MIME_BY_EXT[storeExt] ?? storeMime
        sourceFile = await saveSourceFile(workspaceId, jobId, buffer, storeExt, mime)
        work.meta = { image: 1 }
        work.ocrMime = mime
        work.ocrPageTotal = 1
        work.ocrPageCursor = 0
        work.phase = 'ocr'
      }
      else {
        // Word／簡報／文字檔：抽出純文字，接下來跟 PDF 文字層同一條路
        const extracted = await readingFile(fileName, () => extractOfficeText(buffer, kind))
        if (kind === 'pptx') {
          const slides = Number(extracted.meta.slides ?? 0)
          const unreadable = Number(extracted.meta.slidesUnreadable ?? 0)
          if (!extracted.text.trim()) {
            throw createError({ statusCode: 422, statusMessage: emptySlidesMessage(slides, unreadable) })
          }
          // 字少不少用「讀得出來的」張數算：讀不出來的那幾張下面另外講，不能算成「圖片上的字」
          const readable = slides - unreadable
          if (readable >= 3 && extracted.rawLength / readable < 30) {
            work.warnings.push(`這份簡報讀到的字很少（${readable} 張投影片共 ${extracted.rawLength} 字），圖片上的字讀不到；重點寫在圖片上的話，請把那幾張存成圖片另外傳上來。`)
          }
          if (unreadable > 0) {
            work.warnings.push(`有 ${unreadable} 張投影片讀不出來（可能損毀或內容大到不正常），那幾張沒有收進來；請在 PowerPoint 另存一次再傳。`)
          }
        }
        setChunkingFromExtracted(work, extracted)
      }

      if (decoded) {
        work.meta = { ...work.meta, encoding: decoded.encoding }
        work.warnings.push(...textEncodingWarnings(kind === 'csv' ? 'csv' : 'text', decoded))
      }

      /**
       * 原檔留著（`C-296`③）：每一種檔案都存一份在這個整理工作底下，真的匯入時
       * bulk-create 再複製成這份資料的原檔；沒人匯入就跟著工作過期一起清掉。
       * ⛔ 一定排在抽取**成功之後**：前面任何一步丟錯（壞檔、加密、掃描超過頁數）
       *    都不會建工作，這時已經存進去的檔就沒有任何清理程式找得到（清理是照工作找的）。
       * 掃描 PDF／照片在上面為了認字已經存過，不重存。
       */
      if (!sourceFile) sourceFile = await saveSourceFile(workspaceId, jobId, buffer, storeExt, storeMime)
    }
    catch (err) {
      // 認字那兩條路（掃描 PDF／照片）在上面就存過原檔：之後任何一步丟錯都不會建工作文件，
      // 而清理程式是照工作文件找暫存的——這裡不刪就永遠沒人刪得到
      if (sourceFile) await deleteJobStorage(workspaceId, jobId)
      throw err
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
  try {
    await saveWork(workspaceId, jobId, work)
    await getDb().collection(KNOWLEDGE_PREVIEW_JOBS_COLLECTION).doc(jobId).set(jobDoc)
  }
  catch (err) {
    // 清理程式是照工作文件找暫存的：文件沒寫成，剛存的原檔與 work.json 就永遠沒人清得到
    await deleteJobStorage(workspaceId, jobId)
    throw err
  }

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
    if (Number(meta.size ?? 0) > KNOWLEDGE_FILE_MAX_BYTES) {
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

/** 抽取器丟出「不是我們自己講好的錯」時，店家看到的那一句 */
const FILE_UNREADABLE_MESSAGE = '讀不出這份檔案的內容，可能檔案壞了；請用原本的軟體另存一份再試'

/**
 * 包住每一次抽取：有 `statusCode` 的錯（加密、壞 zip、PDF 頁數讀不到…）是講好的話，原樣往上丟；
 * 其餘（RangeError、解壓到一半壞掉、第三方套件的純 Error）一律換成 422 加一句人話。
 * ⛔ 不攔的話會變成沒有訊息的 500：店家只看到「匯入失敗」，不知道是檔案的問題、也不知道怎麼辦。
 * 真正的原因記一行 log 給我們查。
 */
async function readingFile<T>(fileName: string, read: () => T | Promise<T>): Promise<T> {
  try {
    return await read()
  }
  catch (e) {
    if (typeof (e as { statusCode?: unknown } | null)?.statusCode === 'number') throw e
    const err = e as { name?: string, message?: string } | null
    console.warn(`[preview-jobs] 讀不出檔案內容（回 422）「${fileName}」：${err?.name ?? 'Error'}: ${String(err?.message ?? e).split('\n')[0]}`)
    throw createError({ statusCode: 422, statusMessage: FILE_UNREADABLE_MESSAGE })
  }
}

/**
 * 整份簡報一個字都沒讀到時要講對原因：
 * 「投影片都是圖片」（叫他存成圖片傳）跟「投影片讀不出來＝檔案壞了」（叫他另存一份）是兩件事，
 * 以前一律說「看起來都是圖片」，壞檔的人照著存圖片也救不回來。
 */
function emptySlidesMessage(slides: number, unreadable: number): string {
  if (slides > 0 && unreadable >= slides) {
    return `這份簡報的 ${slides} 張投影片都讀不出來，檔案可能壞了；請用 PowerPoint 打開後另存一份再傳`
  }
  if (unreadable > 0) {
    return `這份簡報讀不到任何文字：${slides - unreadable} 張投影片看起來是圖片、${unreadable} 張讀不出來（檔案可能壞了）；請用 PowerPoint 另存一份再傳，重點在圖片上的話，把那幾張存成圖片（JPG／PNG）再傳`
  }
  return `這份簡報讀不到任何文字（${slides} 張投影片看起來都是圖片）；請把重點那幾張存成圖片（JPG／PNG）再傳，系統會認圖上的字`
}

/** 讀不出來的字超過幾個才講：短檔 1 個就講，長檔 3 個以上才講（見 textEncodingWarnings） */
const UNREADABLE_SHORT_FILE_CHARS = 2000

/**
 * 純文字類檔案（.txt／.md／.csv）的編碼要講出來（`C-296`）——三條路（文字檔、CSV 一列一卡、
 * CSV 退回 AI 整理）講同一套話，以前 Big5 只有 CSV 一列一卡那條會講：
 *  · Big5 是自動認的：猜的要說，萬一其實是簡體或日文，他才知道去哪裡改；
 *  · 讀不出來的字（變成 �）要講幾個：價格、品名少一兩個字，不講的話要等客人問到才會發現。
 *    門檻：2000 字以下的檔 1 個就講（短檔裡一個壞字很可能就是品名或價格）；
 *    更長的檔 3 個以上才講（大檔裡零星一個壞位元組多半是複製貼上帶進來的，每次都提醒只會變成噪音）。
 * ⚠️ `unreadableChars` 由 decodeTextBuffer 數（「�」＋Big5 裡台灣用不到的字）；這裡只決定「講不講」。
 */
function textEncodingWarnings(
  kind: 'text' | 'csv',
  decoded: { text: string, encoding: string, unreadableChars: number },
): string[] {
  const out: string[] = []
  if (decoded.encoding === 'big5') {
    out.push(kind === 'csv'
      ? '這份 CSV 是 Big5 編碼（舊版 Excel 常見），已自動轉成正確的字；如果整理出來的內容是亂碼，請在 Excel 另存成「CSV UTF-8」再傳一次'
      : '這份文字檔是 Big5 編碼（舊版 Windows 常見），已自動轉成正確的字；如果整理出來的內容是亂碼，請用記事本另存成 UTF-8 再傳一次')
  }
  const bad = decoded.unreadableChars
  if (bad >= (decoded.text.length < UNREADABLE_SHORT_FILE_CHARS ? 1 : 3)) {
    out.push(`有 ${bad} 個字讀不出來（變成 �），檔案可能不是 UTF-8 或 Big5 編碼；請用記事本或 Excel 另存成 UTF-8 再匯入一次`)
  }
  return out
}

/**
 * 沒收進來的分頁要講出來（`C-296`）：
 *  · skipped＝看起來是使用說明、沒讀；
 *  · empty＝讀了但一條都沒整理出來（只有一欄、只有欄位名稱）——那頁的內容沒進知識庫。
 */
function sheetCoverageWarnings(skipped: string[], empty: string[] = []): string[] {
  const q = (names: string[]) => names.filter(Boolean).map(n => `「${n}」`).join('、')
  const out: string[] = []
  if (skipped.filter(Boolean).length) out.push(`沒有讀${q(skipped)}分頁（看起來是使用說明）；那頁其實是資料的話，請把分頁改個名字再匯入一次`)
  if (empty.filter(Boolean).length) out.push(`${q(empty)}分頁沒有整理出任何一條（只有一欄、或只有欄位名稱），那頁的內容沒有收進來；要收的話請整理成「名稱｜內容」兩欄以上的表格`)
  return out
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
  // Word／簡報格式複雜到讀到一半就停（標籤、表格多到不正常，見 office-extractors 的讀取額度）：
  // 讀出來的字沒撞到 10 萬字的話，畫面不會講「已截斷」——⛔ 不另外講，他會以為整份都進來了
  if (Number(extracted.meta.textTruncated ?? 0) === 1 && !work.truncated) {
    work.warnings.push('這份檔案的格式複雜到不正常，只讀了前面一部分；後面的內容可能沒收進來，請用原本的軟體另存一份（或匯出成 PDF）再傳')
  }
  primeChunking(work, extracted.text)
}
