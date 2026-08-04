import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import {
  extractPdfText,
  extractUrlText,
  extractXlsxCards,
  extractXlsxText,
  isProbablyScannedPdf,
  MAX_OCR_PAGES,
  MAX_RAW_TEXT_LEN,
  ocrPdfWithGemini,
} from '~~/server/utils/ai-source-extractors'
import { chunkTextWithLlm, summarizeAsOverviewCard } from '~~/server/utils/ai-knowledge-chunker'
import { getDb } from '~~/server/utils/firebase'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { recordAiUsage } from '~~/server/utils/ai-usage'
import { parseGoogleSheetUrl, readGoogleSheetAsCards } from '~~/server/utils/google-sheets'

/**
 * POST /api/ai/knowledge/preview-chunks
 * Body 三選一：
 *   - { type: 'file', fileName, contentType, fileBase64 }
 *   - { type: 'url', url }
 *   - { type: 'text', text }  ← 手打輸入長文要 AI 切片時用
 *
 * 流程：抽純文字 → LLM 切卡。
 * 純預覽：不寫入 Firestore。客戶端確認後再 POST /bulk-create。
 */
/** 偵測同名來源（給前端顯示 dedup 警告用；不阻擋建立，只提醒）。查詢失敗回空陣列。 */
async function findExistingSources(workspaceId: string, sourceName: string) {
  if (!sourceName) return []
  try {
    const db = getDb()
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
    console.warn('[preview-chunks] dedup check failed:', e)
    return []
  }
}

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)
  const type = String(body?.type ?? '').trim()
  // 列表頁（商品首頁等）：除了切碎成個別卡，再額外合成一張「總覽卡」接列舉型問題
  const wantOverview = body?.generateOverview === true

  // ── Google Sheet：一列一卡，程式直接對應，不走 LLM 切卡（零 token、結果穩定）──
  if (type === 'gsheet') {
    const url = String(body?.url ?? '').trim()
    const ref = parseGoogleSheetUrl(url)
    if (!ref) {
      throw createError({ statusCode: 400, statusMessage: '請貼有效的 Google Sheet 連結或試算表 ID' })
    }
    const sheet = await readGoogleSheetAsCards(ref)
    return {
      sourceName: `Google Sheet（${sheet.sheetTitle}）`,
      sourceUrl: url,
      sourceType: 'gsheet',
      rawLength: 0,
      truncated: sheet.stats.truncatedByCap,
      meta: { rows: sheet.stats.rowCount, sheet: sheet.sheetTitle },
      ocrUsed: false,
      chunks: sheet.cards.map(c => ({ title: c.title, content: c.content, tags: c.tags, questions: [] })),
      overviewCard: null,
      existingMatches: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }

  let extracted: { text: string; rawLength: number; meta: Record<string, string | number> }
  let sourceName = ''
  let sourceUrl = ''
  let ocrUsed = false
  let ocrInputTokens = 0
  let ocrOutputTokens = 0

  if (type === 'file') {
    const fileName = String(body?.fileName ?? '').trim()
    const contentType = String(body?.contentType ?? '').trim().toLowerCase()
    const base64 = String(body?.fileBase64 ?? '').trim()
    if (!fileName || !base64) {
      throw createError({ statusCode: 400, statusMessage: '請提供 fileName 與 fileBase64' })
    }
    const buffer = Buffer.from(base64, 'base64')
    if (buffer.length === 0) {
      throw createError({ statusCode: 400, statusMessage: '檔案內容為空' })
    }
    if (buffer.length > 10 * 1024 * 1024) {
      throw createError({ statusCode: 400, statusMessage: '檔案超過 10MB 上限' })
    }

    sourceName = fileName
    const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
    const isPdf = contentType.includes('pdf') || ext === 'pdf'
    const isXlsx = contentType.includes('spreadsheet') || contentType.includes('excel')
      || ext === 'xlsx' || ext === 'xls'

    if (isPdf) {
      extracted = await extractPdfText(buffer)
      // 掃描檔 / 圖片檔 PDF 沒有文字層 → 改用 Gemini 多模態辨識,而不是丟「切不出卡」的誤導錯誤
      if (isProbablyScannedPdf(extracted, buffer.length)) {
        const pages = Number(extracted.meta.pages ?? 0)
        if (pages > MAX_OCR_PAGES) {
          throw createError({
            statusCode: 400,
            statusMessage: `這份 PDF 是掃描檔（無文字層、共 ${pages} 頁），AI 辨識目前支援 ${MAX_OCR_PAGES} 頁以內；請拆分檔案或改貼文字`,
          })
        }
        const ocr = await ocrPdfWithGemini(buffer)
        ocrInputTokens = ocr.inputTokens
        ocrOutputTokens = ocr.outputTokens
        if (!ocr.text) {
          // OCR token 照記:有呼叫就有成本
          await recordAiUsage(workspaceId, {
            inputTokens: ocrInputTokens,
            outputTokens: ocrOutputTokens,
            importInputTokens: ocrInputTokens,
            importOutputTokens: ocrOutputTokens,
          }).catch(() => {})
          throw createError({
            statusCode: 400,
            statusMessage: '這份 PDF 是掃描檔，AI 也辨識不出文字（可能解析度過低或非文字內容）；請改貼文字或提供文字版檔案',
          })
        }
        extracted = { text: ocr.text, rawLength: ocr.rawLength, meta: { ...extracted.meta, ocr: 1 } }
        ocrUsed = true
      }
    }
    else if (isXlsx) {
      // 乾淨表格 → 比照 Google Sheet 一列一卡（不走 LLM、零 token、結果穩定）；
      // 非表格（單欄清單、散裝文字）回 null，往下 fallback 到 extractXlsxText + LLM 切卡。
      const xlsx = extractXlsxCards(buffer)
      if (xlsx) {
        let overviewCard: { title: string; content: string; tags: string[]; questions: string[] } | null = null
        let ovInput = 0
        let ovOutput = 0
        if (wantOverview && xlsx.cards.length >= 2) {
          try {
            const ov = await summarizeAsOverviewCard(xlsx.cards, { hint: sourceName })
            if (ov) {
              overviewCard = {
                title: ov.card.title,
                content: ov.card.content,
                tags: ov.card.tags,
                questions: ov.card.questions ?? [],
              }
              ovInput = ov.inputTokens
              ovOutput = ov.outputTokens
            }
          }
          catch (e) {
            console.warn('[preview-chunks] xlsx overview synthesis failed:', e)
          }
        }
        if (ovInput || ovOutput) {
          await recordAiUsage(workspaceId, {
            inputTokens: ovInput,
            outputTokens: ovOutput,
            importInputTokens: ovInput,
            importOutputTokens: ovOutput,
          }).catch(() => {})
        }
        return {
          sourceName,
          sourceUrl: '',
          sourceType: 'file',
          rawLength: 0,
          truncated: xlsx.stats.truncatedByCap,
          meta: { rows: xlsx.stats.rowCount, sheets: xlsx.sheetCount },
          ocrUsed: false,
          chunks: xlsx.cards.map(c => ({ title: c.title, content: c.content, tags: c.tags, questions: [] as string[] })),
          overviewCard,
          existingMatches: await findExistingSources(workspaceId, sourceName),
          usage: { inputTokens: ovInput, outputTokens: ovOutput },
        }
      }
      extracted = extractXlsxText(buffer)
    }
    else throw createError({ statusCode: 400, statusMessage: `不支援的檔案類型：${ext || contentType}` })
  }
  else if (type === 'url') {
    const url = String(body?.url ?? '').trim()
    if (!url) throw createError({ statusCode: 400, statusMessage: '請輸入網址' })
    extracted = await extractUrlText(url)
    sourceName = url
    sourceUrl = url
  }
  else if (type === 'text') {
    const text = String(body?.text ?? '').trim()
    if (!text) throw createError({ statusCode: 400, statusMessage: '請輸入要整理的文字' })
    if (text.length > MAX_RAW_TEXT_LEN) {
      throw createError({ statusCode: 400, statusMessage: `文字超過 ${MAX_RAW_TEXT_LEN} 字上限` })
    }
    extracted = { text, rawLength: text.length, meta: {} }
    sourceName = String(body?.name ?? '手打輸入').trim()
  }
  else {
    throw createError({ statusCode: 400, statusMessage: '請指定 type: file / url / text' })
  }

  if (!extracted.text) {
    throw createError({ statusCode: 400, statusMessage: '抽出純文字後為空；請確認檔案或連結內容' })
  }

  // 切卡
  const { chunks, inputTokens, outputTokens } = await chunkTextWithLlm(extracted.text, {
    hint: sourceName,
  })

  // 列表頁：再合成一張總覽卡（失敗不擋切卡結果，只記 warning）
  let overviewCard: { title: string; content: string; tags: string[]; questions: string[] } | null = null
  let overviewInputTokens = 0
  let overviewOutputTokens = 0
  if (wantOverview && chunks.length >= 2) {
    try {
      const ov = await summarizeAsOverviewCard(chunks, { hint: sourceName })
      if (ov) {
        overviewCard = {
          title: ov.card.title,
          content: ov.card.content,
          tags: ov.card.tags,
          questions: ov.card.questions ?? [],
        }
        overviewInputTokens = ov.inputTokens
        overviewOutputTokens = ov.outputTokens
      }
    }
    catch (e) {
      console.warn('[preview-chunks] overview synthesis failed:', e)
    }
  }

  // 切卡(+ 掃描檔 OCR + 總覽卡)token 入帳（計入月度總量 quota + import 分項）。
  // 一份大文件可能比幾百次答題還貴，不入帳的話 quota 與成本報表都是失真的。
  const totalInput = inputTokens + ocrInputTokens + overviewInputTokens
  const totalOutput = outputTokens + ocrOutputTokens + overviewOutputTokens
  await recordAiUsage(workspaceId, {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    importInputTokens: totalInput,
    importOutputTokens: totalOutput,
  }).catch(() => {})

  // 偵測同名來源（給前端顯示 dedup 警告用；不阻擋建立，只提醒）
  const existingMatches = (type === 'file' || type === 'url')
    ? await findExistingSources(workspaceId, sourceName)
    : []

  return {
    sourceName,
    sourceUrl,
    sourceType: type,
    rawLength: extracted.rawLength,
    truncated: extracted.rawLength > extracted.text.length,
    meta: extracted.meta,
    ocrUsed,
    chunks,
    overviewCard,
    existingMatches,
    usage: { inputTokens: totalInput, outputTokens: totalOutput },
  }
})
