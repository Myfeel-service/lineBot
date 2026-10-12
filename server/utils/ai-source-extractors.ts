/**
 * 從原始來源（PDF / Excel / URL）抽出純文字，給 LLM 切卡用。
 *
 * 設計重點：
 * - 不做網頁渲染（不破解反爬，符合簡報 p12 紅線）
 * - Excel 直接展開為 "標題: 內容" 形式，方便切卡
 * - 純文字輸出統一斷行，方便 LLM 處理
 */
import * as zlib from 'node:zlib'
import { extractText } from 'unpdf'
import { fetchPublicText } from './safe-fetch'
import * as XLSX from 'xlsx'
import { generateParts } from './gemini'
import {
  countVerticalMerges,
  createCardCollector,
  expandVerticalMerges,
  rowsToCards,
  selectDataSheetNames,
  splitSkippedSheets,
  type MergeRange,
  type SheetCard,
  type SheetImportStats,
} from './google-sheets'
import { decodeTextBuffer, extractDocxText, extractPptxText, readZipDirectory, readZipEntry } from './office-extractors'

/**
 * ⛔ SheetJS 內建的純 JS 解壓，遇到某些壞掉的 zip 會**無限迴圈**（2026-10-11 破檔測試：真的 Numbers 匯出檔
 * 改一個位元組，整個請求卡 20 分鐘；`docProps/app.xml` 裡壞一個壓縮位元組、或 sharedStrings 的檔名長度欄位被改，都會中）。
 * 換成 Node 的 zlib 之後同樣的檔會丟一般的錯（下面 readSpreadsheet 轉成 422），正常的檔照常讀。
 */
/**
 * SheetJS 每解一段就讀 `bytesRead`——Node 把它標成過時（DEP0108），伺服器每次開機都多一行警告（`C-303`⑨）。
 * 同一個數字的新名字叫 `bytesWritten`（Node 文件：bytesRead 就是它的舊別名），包一層讓 SheetJS 讀到新的那個。
 */
class InflateRawWithBytesRead extends zlib.InflateRaw {
  get bytesRead(): number {
    return (this as unknown as { bytesWritten: number }).bytesWritten
  }
}
XLSX.CFB.utils.use_zlib({ ...zlib, InflateRaw: InflateRawWithBytesRead })

/**
 * xlsx 解壓之後（所有項目加起來）最多多大。量過（2026-10-11）：10MB 上限附近、11 萬列×8 欄的 xlsx 解成 41MB，
 * 一般試算表的壓縮比在 3～10 倍。換成 zlib 之後 SheetJS 的解壓**沒有上限**——10MB 的「解壓炸彈」可以撐到好幾 GB，
 * 整台 Lambda 記憶體爆掉，所以交給 SheetJS 之前自己先解一次量實際大小（多花約 0.1 秒）。
 */
const XLSX_MAX_INFLATED_BYTES = 250 * 1024 * 1024

/** 不是 zip（舊版 .xls 是另一種格式）就交給 SheetJS 自己判；是 zip 就實際解一次、超過就丟 422（reason＝too-large） */
function assertXlsxInflatesSanely(buffer: Buffer): void {
  const entries = readZipDirectory(buffer)
  if (!entries) return
  const budget = { left: XLSX_MAX_INFLATED_BYTES }
  for (const entry of entries) {
    if (!entry.name.endsWith('/')) readZipEntry(buffer, entry, budget, XLSX_MAX_INFLATED_BYTES)
  }
}

export const MAX_RAW_TEXT_LEN = 100_000 // 約 30-50 頁的內容上限，避免 LLM 切卡時 prompt 爆炸

/** 掃描檔 OCR 的頁數上限：控制單次匯入的 token 成本（每頁約數百 input token） */
export const MAX_OCR_PAGES = 30

export interface ExtractedSource {
  /** 抓取階段就撞到位元組上限（網頁大於 safe-fetch 的 5MB）→ 內容不完整，要對使用者講 */
  truncatedBySize?: boolean
  /** 純文字內容（已截斷至 MAX_RAW_TEXT_LEN） */
  text: string
  /** 抽出後的原始長度（可能 > text.length，給 UI 提示「已截斷」） */
  rawLength: number
  /** 額外資訊：頁數、sheet 數等 */
  meta: Record<string, string | number>
}

function trimToLimit(text: string): { text: string; rawLength: number } {
  // ⚠️ 寫跳脫字 \0，不要直接打 NUL 位元組：檔案裡有一個 NUL，git 就把整個檔案當二進位、diff 全部看不到
  const raw = text.replace(/\r\n/g, '\n').replace(/\0/g, '').trim()
  if (raw.length <= MAX_RAW_TEXT_LEN) return { text: raw, rawLength: raw.length }
  return { text: raw.slice(0, MAX_RAW_TEXT_LEN), rawLength: raw.length }
}

// ── PDF ─────────────────────────────────────────────────────────────

export async function extractPdfText(buffer: Buffer): Promise<ExtractedSource> {
  const u8 = new Uint8Array(buffer)
  let text: string | string[]
  let totalPages: number | undefined
  try {
    // mergePages=true 直接拿到合併後的字串；page-by-page 沒有切卡的好處，因為 LLM 會自己分主題
    ;({ text, totalPages } = await extractText(u8, { mergePages: true }))
  }
  catch (err: any) {
    // unpdf/pdf.js 對加密、損毀、非標準 PDF 會丟「純 Error」（沒有 statusCode）；
    // 不攔的話會變成前端看到的無訊息 500。轉成可讀的 422 並記下真正原因。
    console.error('[extractPdfText] unpdf failed:', err)
    const msg = String(err?.message ?? '')
    const isEncrypted = /password|encrypt/i.test(msg)
    throw createError({
      statusCode: 422,
      statusMessage: isEncrypted
        ? '這份 PDF 有密碼保護，無法讀取；請移除密碼後再上傳，或改貼文字'
        : `無法解析這份 PDF（可能檔案損毀或格式特殊）；請改貼文字或換一份檔案。原因：${msg || 'unknown'}`,
    })
  }
  const merged = Array.isArray(text) ? text.join('\n') : String(text)
  const { text: t, rawLength } = trimToLimit(merged)
  return { text: t, rawLength, meta: { pages: totalPages ?? 0 } }
}

/**
 * 判斷 PDF 是否為掃描檔/圖片檔(沒有可用的文字層)。
 * 掃描檔通常完全沒字、或只剩浮水印/頁首這類零星文字;
 * 用「總字數很少」或「平均每頁字數過低」當訊號。誤判成掃描檔的代價只是多一次 OCR,可接受。
 *
 * byteLength(原始檔位元組數,可選)是第三個訊號:影像為主的 PDF(掃描檔、整頁都是圖的
 * 型錄/DM)常帶「薄薄一層」文字(頁首、圖說、浮水印),字數足以越過上面的每頁門檻,卻切不出
 * 有意義的卡。用「檔案大小 ÷ 抽出字數」補一刀——一般數位文字 PDF 約幾十 bytes/字,影像檔
 * 動輒數百到上千 bytes/字。給了 byteLength 才啟用這條;沒給(舊呼叫端)行為不變。
 */
export function isProbablyScannedPdf(extracted: ExtractedSource, byteLength = 0): boolean {
  const pages = Number(extracted.meta.pages ?? 0)
  const text = extracted.rawLength
  // 文字層已經夠厚就不是掃描檔（C-49D）：8MB 圖多字少的型錄抽得出 2 萬字，
  // 卻因 bytes/字 > 300 被誤判成掃描檔 → 白跑整套 OCR（最多 6 次 32k output 的多模態呼叫）。
  // 「多一次 OCR 可接受」的舊註解寫在 job 化之前，代價早就不一樣了。
  // 門檻 5000 不是 3000：既有案例「5MB 只抽出 3000 字（150 字/頁）」是真的薄文字層、
  // 該走 OCR——地板要高於那種型錄的量級，只放行「文字明顯完整」的檔。
  if (text >= 5000) return false
  if (pages <= 0) return text < 50
  if (text < 120 || text / pages < 25) return true
  // 大檔卻只抽出很少字 → 影像為主(型錄/掃描),薄文字層騙過了上面的門檻 → 當掃描檔走 OCR。
  if (byteLength > 1_000_000 && byteLength / Math.max(1, text) > 300) return true
  return false
}

const OCR_PROMPT = `這是一份掃描或圖片格式的 PDF。請把文件中所有可辨識的文字完整轉錄成純文字：
- 依原文語言照實轉錄，不要翻譯、不要摘要、不要自行補充內容
- 表格請逐列轉成「欄位：值」的文字形式
- 忽略浮水印、頁碼、頁首頁尾
- 如果整份文件沒有可辨識的文字，輸出空字串`

/**
 * 掃描檔 fallback：把整份 PDF 丟給 Gemini 多模態辨識文字。
 * caller 負責頁數上限檢查(MAX_OCR_PAGES)與 token 入帳。
 */
export async function ocrPdfWithGemini(buffer: Buffer): Promise<ExtractedSource & { inputTokens: number; outputTokens: number }> {
  const { text, inputTokens, outputTokens } = await generateParts(
    [
      { inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') } },
      { text: OCR_PROMPT },
    ],
    {
      temperature: 0,
      // 30 頁中文文件全文可能到 3 萬多 token;cap 太低會默默截斷
      maxOutputTokens: 32768,
      // 純轉錄不需要 thinking;省 token 也避免 thinking 吃掉輸出配額
      thinkingBudget: 0,
    },
  )
  const { text: t, rawLength } = trimToLimit(text)
  return { text: t, rawLength, meta: { ocr: 1 }, inputTokens, outputTokens }
}

// ── 照片（`C-296`）───────────────────────────────────────────────────

/** 收得下的照片種類 → 交給 Gemini 的 MIME。iPhone 預設拍出來的是 HEIC，一定要收。 */
export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
}

const IMAGE_OCR_PROMPT = `這是一張照片或圖片（可能是價目表、菜單、DM、公告或說明）。請把圖中所有可辨識的文字完整轉錄成純文字：
- 依原文語言照實轉錄，不要翻譯、不要摘要、不要自行補充內容
- 表格或價目表請逐列轉成「欄位：值」的文字形式（例：品名：拿鐵；中杯：60；大杯：75）
- 忽略浮水印與跟內容無關的背景文字
- 如果圖中沒有可辨識的文字，輸出空字串`

/** 照片認字：跟掃描 PDF 走同一套（temperature 0、不要 thinking），只差交給模型的是圖片。 */
export async function ocrImageWithGemini(
  buffer: Buffer,
  mimeType: string,
): Promise<ExtractedSource & { inputTokens: number; outputTokens: number }> {
  const { text, inputTokens, outputTokens } = await generateParts(
    [
      { inlineData: { mimeType, data: buffer.toString('base64') } },
      { text: IMAGE_OCR_PROMPT },
    ],
    { temperature: 0, maxOutputTokens: 8192, thinkingBudget: 0 },
  )
  const { text: t, rawLength } = trimToLimit(text)
  return { text: t, rawLength, meta: { ocr: 1 }, inputTokens, outputTokens }
}

// ── Word／PowerPoint／純文字檔（`C-296`）────────────────────────────

/** docx／pptx／txt／md → 跟 PDF 文字層同一種形狀，接下來一樣交給 AI 整理。 */
export function extractOfficeText(buffer: Buffer, kind: 'docx' | 'pptx' | 'text'): ExtractedSource {
  let text: string
  let meta: Record<string, string | number>
  if (kind === 'docx') ({ text, meta } = extractDocxText(buffer))
  else if (kind === 'pptx') ({ text, meta } = extractPptxText(buffer))
  else {
    const decoded = decodeTextBuffer(buffer)
    text = decoded.text
    meta = { encoding: decoded.encoding }
  }
  const { text: t, rawLength } = trimToLimit(text)
  return { text: t, rawLength, meta }
}

// ── Excel ───────────────────────────────────────────────────────────

/**
 * 挑要當資料讀的分頁——與 Google Sheet 共用 selectDataSheetNames 同一套規則
 * （全部非說明頁、跳過 Numbers 的輸出摘要），確保「上傳 Excel」與「貼 Sheet 連結」結果一致。
 * 上傳的檔案沒有「舊來源」問題（不會同步），一律用新規則。
 */
function usableSheetNames(wb: XLSX.WorkBook): string[] {
  return selectDataSheetNames(wb.SheetNames, { legacy: false })
}

export type SpreadsheetKind = 'xlsx' | 'csv'

type ParsedBook = { wb: XLSX.WorkBook, encoding?: string }

/**
 * 讀成活頁簿。CSV 先自己判斷編碼（Big5／UTF-8／UTF-16）再交給 SheetJS，
 * 而且 `raw: true`：⛔ 不讓 SheetJS 猜型別——猜了的話「0912345678」變成 912345678、
 * 「2026/10/01」變成日期序號，電話跟日期整欄壞掉，而且畫面上看不出來是我們弄的。
 *
 * `dense: true`（2026-10-11 量過，10MB 上限附近、約 11 萬列×8 欄、整條匯入路徑）：預設的「一格一個屬性」讀法
 * xlsx 2.4 秒／記憶體高峰 436MB、CSV 1.1 秒／366MB；改成每列一個陣列後 xlsx 約 1.7 秒／367MB、CSV 約 0.23 秒／292MB。
 * 讀出來的內容一樣，唯一差別是整列空白回 `[]` 而不是一排空字串——下面每一步都先濾掉空白列，結果相同
 * （真的 Numbers 輸出檔、官方範本、上面那兩份大檔逐卡比對過）。
 */
export function readSpreadsheet(buffer: Buffer, kind: SpreadsheetKind = 'xlsx'): ParsedBook {
  try {
    if (kind === 'csv') {
      const { text, encoding } = decodeTextBuffer(buffer)
      return { wb: XLSX.read(text, { type: 'string', raw: true, dense: true }), encoding }
    }
    assertXlsxInflatesSanely(buffer)
    return { wb: XLSX.read(buffer, { type: 'buffer', dense: true }) }
  }
  catch (err: any) {
    // XLSX.read 對損毀 / 受密碼保護 / 非 Excel 的檔會丟純 Error（沒有 statusCode）→ 無訊息 500。
    // ⛔ 解析器的原文（英文、技術細節）只進 log、一行就好；畫面上給店家看得懂、知道下一步的話
    console.warn(`[readSpreadsheet] ${kind} 讀取失敗：${String(err?.message ?? err).slice(0, 200)}`)
    throw createError({
      statusCode: 422,
      statusMessage: kind === 'csv'
        ? '讀不出這份 CSV，可能檔案壞了或不是用逗號分隔；請用 Excel 打開、另存成 .xlsx 再試'
        : err?.reason === 'too-large'
          ? '這份試算表解開之後大到不正常（超過 250MB）；請把資料拆成幾份、或刪掉用不到的分頁再傳'
          : '讀不出這份試算表，可能檔案壞了或有密碼；請用 Excel 另存一份再試',
    })
  }
}

/**
 * extractXlsxCards 判定「不是表格」回 null 之後，呼叫端（preview-jobs）會拿**同一個 buffer**
 * 接著呼叫 extractXlsxText——以前那份檔就整份再讀一次（10MB 的檔多花一倍時間，讀壞的檔也記兩次 log）。
 * 這裡把讀好的結果（或讀檔的錯）交給下一棒；只在回 null 的那條路放，拿了就刪，
 * 表格那條路不留——留著的話活頁簿會一直佔著記憶體到整個請求結束。
 * 用 WeakMap：buffer 沒人用了就跟著收掉，不會漏記憶體。
 */
const handoff = new WeakMap<Buffer, { kind: SpreadsheetKind, book?: ParsedBook, error?: unknown }>()

function readSpreadsheetOnce(buffer: Buffer, kind: SpreadsheetKind): ParsedBook {
  const h = handoff.get(buffer)
  if (h && h.kind === kind) {
    handoff.delete(buffer)
    if (h.error) throw h.error
    return h.book!
  }
  return readSpreadsheet(buffer, kind)
}

/**
 * xlsx 的 !merges（s/e 皆含）→ 正規化 MergeRange（end 不含），與 gsheet 共用展開邏輯。
 *
 * !merges 是「絕對格線座標」，但 sheet_to_json({ header: 1 }) 回傳的列/欄是「相對於 !ref 原點」的
 * ——資料不從 A1 起算時（上方有空白列、或左方有空白欄）兩者會錯位，導致該展開的直向合併被跳過、
 * 標題欄被合併的列被 rowToCard 整列丟掉（靜默漏資料）。減掉 !ref 起點讓座標與陣列索引對齊。
 */
function xlsxMergeRanges(sheet: XLSX.WorkSheet): MergeRange[] {
  const merges = sheet['!merges'] ?? []
  if (!merges.length) return []
  const origin = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).s : { r: 0, c: 0 }
  return merges.map(m => ({
    startRow: m.s.r - origin.r,
    endRow: m.e.r + 1 - origin.r,
    startCol: m.s.c - origin.c,
    endCol: m.e.c + 1 - origin.c,
  }))
}

/** sheet_to_json 的第一列在試算表上是第幾列（同 xlsxMergeRanges：資料不一定從第 1 列開始） */
function xlsxFirstRow(sheet: XLSX.WorkSheet): number {
  return sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).s.r + 1 : 1
}

export function extractXlsxText(buffer: Buffer, kind: SpreadsheetKind = 'xlsx'): ExtractedSource {
  const { wb } = readSpreadsheetOnce(buffer, kind)
  const lines: string[] = []

  for (const sheetName of usableSheetNames(wb)) {
    const sheet = wb.Sheets[sheetName]
    if (!sheet) continue
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
      raw: false,
    })
    if (!rows.length) continue

    lines.push(`# 分頁：${sheetName}`)
    for (const row of rows) {
      const entries = Object.entries(row).filter(([, v]) => String(v ?? '').trim())
      if (!entries.length) continue
      // 兩欄表（Q/A 或 標題/內容）特殊處理：直接 "Q: ... A: ..."
      if (entries.length === 2) {
        lines.push(`${entries[0]![1]}：${entries[1]![1]}`)
      }
      else {
        lines.push(entries.map(([k, v]) => `${k}：${v}`).join('；'))
      }
    }
    lines.push('') // sheet 間空一行
  }

  const merged = lines.join('\n').trim()
  const { text, rawLength } = trimToLimit(merged)
  return { text, rawLength, meta: { sheets: wb.SheetNames.length } }
}

export interface XlsxCardsResult {
  cards: SheetCard[]
  /** 實際被當成表格處理的分頁數 */
  sheetCount: number
  /** 直向合併儲存格總數（已自動展開；給健檢提示用） */
  mergeCount: number
  /** 匯入健檢統計（跨分頁彙總），給 sheetHealthWarnings 用 */
  stats: SheetImportStats
  /** 沒讀的分頁（使用說明頁）；預覽要講出來。Numbers 的輸出摘要另外放在 stats.exportSummarySheets */
  skippedSheets: string[]
  /** 有讀、但不是表格或一條都沒整理出來的分頁（只有一欄、只有欄位名稱）；內容沒收進來，要講 */
  emptySheets: string[]
  /** CSV 認出來的編碼（Big5 要講一聲，讀錯時他才知道原因） */
  encoding?: string
}

/**
 * 上傳的 Excel「乾淨表格」→ 一列一卡，比照 Google Sheet 的 rowsToCards（不走 LLM）。
 *
 * 判定「乾淨表格」：某分頁有 ≥ 2 列非空、且 ≥ 2 欄，才視為可程式對應的表格。
 * 逐分頁處理、跨分頁累積（欄位名稱那列每頁自己找），套用 GSHEET_MAX_ROWS 上限。
 * 收滿了也照樣讀後面的分頁：同名的列還要併進已收的那幾條（見 createCardCollector）。
 *
 * 回傳 null 代表「不是表格」（例如單欄清單、散裝文字），呼叫端應 fallback 回
 * extractXlsxText + LLM 切卡。解析失敗也回 null，讓 extractXlsxText 去丟對應的錯誤訊息。
 */
export function extractXlsxCards(buffer: Buffer, kind: SpreadsheetKind = 'xlsx'): XlsxCardsResult | null {
  let book: ParsedBook
  try {
    book = readSpreadsheet(buffer, kind)
  }
  catch (err) {
    handoff.set(buffer, { kind, error: err })
    return null
  }
  const { wb, encoding } = book

  // 跨分頁收成一疊（同名的併成一張），跟 Google Sheet 同一支，見 createCardCollector
  const collector = createCardCollector({ legacy: false })
  let sheetCount = 0
  let mergeCount = 0
  const emptySheets: string[] = []
  const usable = usableSheetNames(wb)
  for (const sheetName of usable) {
    const sheet = wb.Sheets[sheetName]
    if (!sheet) continue
    // header:1 → 取「陣列的陣列」原始列，跟 Google Sheet 的 values 同格式（中間的空白列也會回來，列號才對得上）
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false }) as unknown[][]
    const nonEmpty = rows.filter(r => Array.isArray(r) && r.some(c => String(c ?? '').trim()))
    const maxCols = nonEmpty.reduce((m, r) => Math.max(m, r.length), 0)
    // 太窄（< 2 欄）或列數不足就不算表格。⛔ 不可以默默跳過：記下來在預覽講「這頁沒收進來」
    if (nonEmpty.length < 2 || maxCols < 2) {
      if (nonEmpty.length) emptySheets.push(sheetName)
      continue
    }

    // 跨列合併儲存格展開（同 gsheet）：標題欄被直向合併時，救回會被整列丟掉的資料
    const merges = xlsxMergeRanges(sheet)
    const stringRows = expandVerticalMerges(
      rows.map(r => (Array.isArray(r) ? r.map(c => String(c ?? '')) : [])),
      merges,
    )
    const { cards: sheetCards, stats: sheetStats } = rowsToCards(stringRows, { legacy: false, firstRow: xlsxFirstRow(sheet) })
    if (!sheetCards.length) { emptySheets.push(sheetName); continue }

    sheetCount += 1
    mergeCount += countVerticalMerges(merges)
    collector.addSheet(sheetCards, sheetStats, sheetName)
  }

  if (!collector.cards.length) {
    handoff.set(buffer, { kind, book })
    return null
  }
  return {
    cards: collector.cards,
    sheetCount,
    mergeCount,
    stats: collector.stats,
    skippedSheets: splitSkippedSheets(wb.SheetNames, usable, collector.stats),
    emptySheets,
    encoding,
  }
}

// ── URL ─────────────────────────────────────────────────────────────

/**
 * 抓網頁並抽純文字。只走標準 fetch、不做 headless 渲染、不繞反爬。
 * 抓不到 = 抓不到，請使用者改用「手打」或「上傳檔案」。
 */
export async function extractUrlText(url: string): Promise<ExtractedSource> {
  const u = String(url || '').trim()
  if (!/^https?:\/\//i.test(u)) {
    throw createError({ statusCode: 400, statusMessage: 'URL 必須為 http:// 或 https:// 開頭' })
  }

  // safe-fetch（C-49A）：逐跳擋私有網段（SSRF）＋streaming 大小上限（防超大回應 OOM）。
  // 原本 res.text() 整包進記憶體、redirect 交給 fetch 自動跟——轉址到內網是最典型的繞法。
  const res = await fetchPublicText(u, {
    timeoutMs: 15_000,
    headers: {
      // 友善 user-agent，遇到反爬就放棄
      'User-Agent': 'LineBotKnowledgeFetcher/1.0',
      'Accept': 'text/html,application/xhtml+xml',
    },
  })

  if (!res.ok) {
    throw createError({ statusCode: 502, statusMessage: `網址回應 ${res.status}：請確認連結公開可訪問` })
  }

  const ct = res.contentType.toLowerCase()
  const html = res.text

  // PDF / 非 HTML 不在這支處理
  if (!ct.includes('html') && !ct.includes('text/plain')) {
    throw createError({ statusCode: 400, statusMessage: `不支援的內容類型：${ct || '未知'}（請改用上傳檔案）` })
  }

  // 用最終 URL（跟完 redirect）當 base 解析相對連結，讓切卡能把「品項 → 連結」一起帶走
  const text = stripHtml(html, res.finalUrl || u)
  const { text: t, rawLength } = trimToLimit(text)
  // 抓取層的 5MB 上限有沒有真的截到要傳下去（C-49A）：不傳的話又是一個「做一半沒人講」，
  // 頁面後半整段消失、下一輪偵測還會把截斷版當成新基準，從此連「有變動」都不報。
  return { text: t, rawLength, meta: { contentType: ct }, ...(res.truncatedBySize ? { truncatedBySize: true } : {}) }
}

/**
 * 擷取層品質守門:內容太薄 / 疑似只抓到選單頁尾 → 給使用者可行動的警示,不擋流程。
 * 7/31 總覽卡事故的根源就是動態首頁只抓到頁腳、切出 11 張平台雜卡而**無任何警示**。
 *
 * 匯入與「重新同步」共用同一套判斷:同一個網址在兩條路上要得到同樣的診斷,
 * 否則重新同步的人只會看到籠統的縮水警告,看不到「這是動態網頁,改用列表頁」這句已經寫好的解法。
 */
export function extractionQualityWarnings(sourceType: string, text: string, truncatedBySize = false): string[] {
  const warnings: string[] = []
  if (truncatedBySize) {
    warnings.push('這個網頁太大（超過 5MB），只讀到前面一段就停了——後半段的內容沒有進知識庫。建議改用內容較少的分頁（例如單一商品頁）當資料來源。')
  }
  const len = text.trim().length
  if (len > 0 && len < 300) {
    warnings.push(sourceType === 'url'
      // 「貼上文字」不是畫面上任何東西的名字（加入視窗只有一個框，2026-10-12 文字審視）：講動作，不講不存在的選項
      ? `這個網址只擷取到約 ${len} 字——很可能是動態網頁（內容由程式載入），伺服器抓不到主要內容。建議改用靜態的商品列表頁網址，或把頁面上的文字複製、直接貼進加入知識的框。`
      // ⚠️ 不寫「下一步」：一次好幾份（`C-296`④）沒有預覽那一步，叫人「在下一步確認」是指向一個不存在的畫面
      : `只讀到約 ${len} 字，內容可能不完整；請點開確認整理出來的知識對不對。`)
  }
  else if (sourceType === 'url') {
    // 連結密度過高 = 內文多半是選單 / 頁尾（stripHtml 會把站內連結轉成「錨文字（網址）」）
    const linkCount = (text.match(/https?:\/\//g) ?? []).length
    if (linkCount >= 5 && len / linkCount < 80) {
      warnings.push('擷取到的內容大多是連結（可能只抓到選單和頁尾、沒抓到主要內容）——整理出來的知識若沒有實質商品內容，請改用商品列表頁網址或直接貼文字。')
    }
  }
  return warnings
}

/**
 * 把連結 href 解析成絕對網址；只保留「與來源同網域」的 http(s) 連結
 * （站內頁面才有價值；外部社群 / js: / 錨點一律丟掉，避免雜訊與 token 浪費）。
 * 解析失敗或跨網域回 null。通用——不綁任何特定站台。
 */
export function resolveInternalUrl(href: string, baseUrl: string): string | null {
  try {
    const abs = new URL(href, baseUrl)
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null
    if (abs.host !== new URL(baseUrl).host) return null
    return abs.href
  }
  catch {
    return null
  }
}

/**
 * 把 HTML 變成純文字：拿掉 script/style/註解，再剝標籤、解 entity。
 * 簡單夠用，不引入 cheerio。
 */
function stripHtml(html: string, baseUrl?: string): string {
  let s = html
  // 拿掉 script / style / noscript
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
  // 導覽 / 頁尾 / 側欄整塊剝掉：選單、cookie 聲明這類雜訊每次都計入切卡 input token，
  // 內容農場式頁面可佔 30–50%。非貪婪比對在巢狀時只會剝到第一個閉合，剝不乾淨也無害（LLM 規則會濾）。
  s = s.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  // 註解
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  // 連結：把站內 <a href> 轉成「錨文字（絕對網址）」，讓切卡能把品項與其頁面網址綁在一起。
  // 必須在「拔掉所有標籤」之前做，否則 href 就沒了。只在有 baseUrl 時啟用（URL 來源才有意義）。
  if (baseUrl) {
    s = s.replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      const abs = resolveInternalUrl(href, baseUrl)
      if (!label) return ' '
      return abs ? ` ${label}（${abs}） ` : ` ${label} `
    })
  }
  // 換行類標籤先變 \n
  s = s.replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
  // 剩下標籤全拔
  s = s.replace(/<[^>]+>/g, ' ')
  // entity（常見幾個就好；不為了萬一引入 he 套件）
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  // 壓掉多餘空白
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
  return s.trim()
}
