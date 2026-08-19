/**
 * Google Sheet 讀取 + 「一列 = 一張知識卡」對應。
 *
 * 設計：
 * - 用既有的 Firebase 服務帳號憑證（firebaseClientEmail / firebasePrivateKey）換 access token，
 *   不另外申請憑證。商家把自己的 Sheet「分享給服務帳號 email（檢視權限）」即可。
 * - 走 Sheets API REST（values.get）+ fetch，不引入 googleapis 重套件。
 * - 做法 1：Sheet 本來就是結構化表格，直接「一列一卡」程式對應，不丟 LLM 切卡
 *   → 自動同步時零 LLM 成本、結果穩定、商家可預期。
 *
 * 紅線：只讀「分享給服務帳號」的 Sheet，不繞權限；讀不到就請商家確認分享設定。
 */
import { JWT } from 'google-auth-library'

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

/** 一張 Sheet 最多轉幾張卡（與 bulk-create 的 MAX_BULK_CHUNKS 對齊，避免匯入超量） */
export const GSHEET_MAX_ROWS = 150

/** 單卡內容上限（與 validateChunkInput 的 5000 對齊） */
const CARD_CONTENT_MAX = 5000

/** 服務帳號的 row→card 結果 */
export interface SheetCard {
  title: string
  content: string
  tags: string[]
}

export interface ReadSheetResult {
  /** 解析出的卡片（已套用 GSHEET_MAX_ROWS 上限、同標題已合併） */
  cards: SheetCard[]
  /** 實際讀取的分頁標題 */
  sheetTitle: string
  /** 該分頁的直向合併儲存格數（已自動展開；給健檢提示用） */
  mergeCount: number
  /** 匯入健檢統計（列數、被略過/合併/沒答案等），給 sheetHealthWarnings 用 */
  stats: SheetImportStats
}

// ── 服務帳號 token（JWT client 內部自動快取/續期，建一次重用） ──────────
let jwtClient: JWT | null = null

function getJwtClient(): JWT {
  if (jwtClient) return jwtClient
  const config = useRuntimeConfig()
  const email = config.firebaseClientEmail
  const key = String(config.firebasePrivateKey || '').replace(/\\n/g, '\n')
  if (!email || !key) {
    throw createError({ statusCode: 500, statusMessage: '伺服器未設定 Google 服務帳號憑證' })
  }
  jwtClient = new JWT({ email, key, scopes: [SHEETS_SCOPE] })
  return jwtClient
}

/** 這個部署用哪個服務帳號 email 讀 Sheet（給前端提示「請把表單分享給這個帳號」）。 */
export function getServiceAccountEmail(): string {
  return useRuntimeConfig().firebaseClientEmail || ''
}

async function getAccessToken(): Promise<string> {
  const { token } = await getJwtClient().getAccessToken()
  if (!token) throw createError({ statusCode: 502, statusMessage: '無法取得 Google 存取權杖' })
  return token
}

// ── URL / id 解析 ───────────────────────────────────────────────────

export interface ParsedSheetRef {
  spreadsheetId: string
  /** URL #gid=... 指定的分頁數字 id；沒有則 null（讀第一個分頁） */
  gid: string | null
}

/**
 * 從使用者貼的內容解析出 spreadsheetId 與 gid。接受：
 *   - 完整網址 https://docs.google.com/spreadsheets/d/<ID>/edit#gid=123
 *   - 純 spreadsheetId（44 字左右的英數 + - _）
 * 解析不出 id 回 null。
 */
export function parseGoogleSheetUrl(input: string): ParsedSheetRef | null {
  const raw = String(input || '').trim()
  if (!raw) return null

  const idFromUrl = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  const gidMatch = raw.match(/[#&?]gid=([0-9]+)/)
  if (idFromUrl?.[1]) {
    return { spreadsheetId: idFromUrl[1], gid: gidMatch?.[1] ?? null }
  }
  // 純 id（沒有斜線、沒有空白、長度合理）
  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw)) {
    return { spreadsheetId: raw, gid: null }
  }
  return null
}

// ── Sheets API 呼叫 ─────────────────────────────────────────────────

async function sheetsApi<T>(path: string): Promise<T> {
  const token = await getAccessToken()
  let res: Response
  try {
    res = await fetch(`${SHEETS_API_BASE}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
  }
  catch (err: any) {
    throw createError({ statusCode: 502, statusMessage: `Google Sheets 連線失敗：${err?.message ?? 'unknown'}` })
  }
  if (res.status === 403 || res.status === 404) {
    // 403 有兩種：API 沒啟用 vs 表單沒分享。讀 body 區分，給對應排查指引。
    const body = await res.text().catch(() => '')
    // Google 的原始 error.message 內含「確切的專案編號 + 啟用連結」，直接透出，避免猜錯專案
    let googleMsg = ''
    try { googleMsg = String(JSON.parse(body)?.error?.message ?? '') }
    catch { googleMsg = body.slice(0, 400) }
    const apiDisabled = /SERVICE_DISABLED|has not been used in project|Sheets API.*disabled/i.test(body)
    const email = getServiceAccountEmail()
    throw createError({
      statusCode: 422,
      statusMessage: apiDisabled
        ? `Google Sheets API 尚未在「服務帳號所屬的專案」啟用。請依 Google 指示的連結（含正確專案編號）啟用後等 1–2 分鐘再試。Google 原始訊息：${googleMsg}`
        : `讀不到這份 Google Sheet（${res.status}）。請把表單「分享」給服務帳號：${email}（檢視權限即可，並取消勾選「通知使用者」）。Google 原始訊息：${googleMsg}`,
    })
  }
  if (res.status === 400) {
    const body = await res.text().catch(() => '')
    // 上傳的 Excel 檔留在 Drive 的「Office 相容模式」（網址常帶 rtpof=true），不是原生 Google 試算表，
    // Sheets API 不支援 → 給明確的轉檔指引，而不是丟原始 400。
    if (/must not be an Office file|not supported for this document/i.test(body)) {
      throw createError({
        statusCode: 422,
        statusMessage: '這個連結是「上傳的 Excel 檔」（還沒轉成 Google 試算表），系統讀不到。請在 Google 試算表裡點「檔案 → 另存為 Google 試算表」，用轉好的新檔分享給服務帳號、再貼新連結；或直接改用「下載 FAQ 範本」在 Google 雲端硬碟新建試算表。',
      })
    }
    throw createError({ statusCode: 502, statusMessage: `Google Sheets API 錯誤 400：${body.slice(0, 200)}` })
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw createError({ statusCode: 502, statusMessage: `Google Sheets API 錯誤 ${res.status}：${body.slice(0, 200)}` })
  }
  return res.json() as Promise<T>
}

interface SheetMeta {
  sheets?: SheetMetaEntry[]
}

interface SheetMetaEntry {
  properties?: { sheetId?: number; title?: string }
  merges?: Array<{
    startRowIndex?: number
    endRowIndex?: number
    startColumnIndex?: number
    endColumnIndex?: number
  }>
}

/** 正規化的合併範圍（列/欄皆 0-based、end 不含），gsheet 與 xlsx 共用。 */
export interface MergeRange {
  startRow: number
  endRow: number
  startCol: number
  endCol: number
}

/**
 * 分頁名稱是否為「使用說明」類（官方範本第二分頁、商家自己寫的教學頁）。
 * 這種分頁不是知識資料，自動挑分頁時要跳過——否則說明文字會被匯成知識卡。
 */
export function isInstructionSheetName(name: string): boolean {
  // 只認「整個分頁名就是說明/教學類」；避免誤傷「商品說明」「產品說明」「教學課程清單」這類
  // 內含這些字的合法資料分頁（否則整頁資料會被靜默跳過）。先去掉開頭 emoji/符號（範本常見「📖 使用說明」）。
  const n = String(name || '').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase()
  return /^(使用|填寫|操作|匯入|範本|欄位)?說明(頁|文件)?$/.test(n)
    || /^(使用|填寫|操作)?教學$/.test(n)
    || /^readme$/.test(n)
    || /^instructions?$/.test(n)
    || /^how[\s-]?to/.test(n)
}

/**
 * 決定要讀哪些分頁的「名稱」（Excel 上傳與 Google Sheet 共用同一套規則，確保兩邊結果一致）：
 * 1. 名稱含 FAQ / 常見問 的分頁 → 只讀這些（官方範本的資料頁叫「FAQ」）。
 * 2. 否則 → 全部「非說明」分頁（跳過使用說明 / 教學頁）。
 * 3. 保底：整份都是說明類名稱時，全讀（寧可多匯，也不要讓使用者面對空結果）。
 *
 * 註：Google Sheet 若連結帶 #gid= 指定分頁，由呼叫端優先處理（尊重使用者指定），不走這裡。
 */
export function selectDataSheetNames(names: string[]): string[] {
  const faq = names.filter(n => /faq|常見問/i.test(String(n ?? '')))
  if (faq.length) return faq
  const nonInstruction = names.filter(n => !isInstructionSheetName(String(n ?? '')))
  return nonInstruction.length ? nonInstruction : names
}

/** 一個分頁 meta → { title, 正規化並過濾後的合併範圍 } */
function toSheetTarget(s: SheetMetaEntry): { title: string; merges: MergeRange[] } {
  const merges: MergeRange[] = (s.merges ?? [])
    .map(m => ({
      startRow: Number(m.startRowIndex ?? 0),
      endRow: Number(m.endRowIndex ?? 0),
      startCol: Number(m.startColumnIndex ?? 0),
      endCol: Number(m.endColumnIndex ?? 0),
    }))
    .filter(m => m.endRow > m.startRow && m.endCol > m.startCol)
  return { title: s.properties?.title ?? 'Sheet1', merges }
}

/** Sheets API 存取函式（預設走真的 sheetsApi；測試可注入假的以避開網路）。 */
export type SheetsApiFn = <T>(path: string) => Promise<T>

/**
 * 挑要讀哪些分頁（回傳標題 + 各分頁的合併範圍）：
 * - 連結有 #gid= 且對得上 → 只讀那頁（尊重使用者指定，即使是說明頁也照讀）。
 * - 否則走 selectDataSheetNames（FAQ 頁優先，否則全部非說明頁）——與 Excel 上傳同規則。
 */
async function selectSheetsToRead(
  spreadsheetId: string,
  gid: string | null,
  api: SheetsApiFn = sheetsApi,
): Promise<Array<{ title: string; merges: MergeRange[] }>> {
  const meta = await api<SheetMeta>(
    `${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent('sheets(properties(sheetId,title),merges)')}`,
  )
  const sheets = meta.sheets ?? []
  if (!sheets.length) throw createError({ statusCode: 422, statusMessage: '這份試算表沒有任何分頁' })

  if (gid != null) {
    const hit = sheets.find(s => String(s.properties?.sheetId) === gid)
    if (hit) return [toSheetTarget(hit)]
    // ⛔指定的分頁不見了（被刪除重建 gid 就會變）→ 直接失敗，不退回名稱猜測。
    // 退回猜測的下場：改讀到「使用說明」頁 → 說明文字變知識卡、原 FAQ 卡整批被判
    // 「表上已不存在」刪光——靜默讀錯頁比讀不到危險得多。
    throw createError({
      statusCode: 422,
      statusMessage: '原本指定的分頁已不存在（分頁被刪除重建時，連結裡的 gid 會變）。請確認試算表分頁，重新貼一次正確的分頁連結。',
    })
  }
  const pick = new Set(selectDataSheetNames(sheets.map(s => s.properties?.title ?? '')))
  const selected = sheets.filter(s => pick.has(s.properties?.title ?? ''))
  return (selected.length ? selected : sheets).map(toSheetTarget)
}

/**
 * 把「跨列」合併儲存格的值往下展開（原地修改並回傳 rows）。
 *
 * 為什麼只展開直向：API 只在合併區的左上格回值，其餘格為空——標題欄被直向合併時，
 * 後續列會因「沒標題」被 rowToCard 整列丟掉（靜默漏資料）。把錨點值沿「錨點那一欄」
 * 往下補就能救回。橫向不展開：把同一段文字複製到多個欄位，會讓多欄表的
 * 「表頭：值」內容重複，比不展開更糟。
 *
 * 只補「已存在的列」：合併範圍若延伸到沒有任何內容的列，不無中生有造列
 * （那種列本來就沒資料，補了只會生出「標題即內容」的垃圾卡）。
 */
export function expandVerticalMerges(rows: string[][], merges: MergeRange[]): string[][] {
  for (const m of merges) {
    if (m.endRow - m.startRow < 2) continue // 純橫向合併不處理
    const anchorRow = rows[m.startRow]
    if (!anchorRow) continue
    const value = String(anchorRow[m.startCol] ?? '')
    if (!value.trim()) continue
    for (let r = m.startRow + 1; r < Math.min(m.endRow, rows.length); r++) {
      const row = rows[r]!
      while (row.length <= m.startCol) row.push('')
      if (!String(row[m.startCol] ?? '').trim()) row[m.startCol] = value
    }
  }
  return rows
}

/**
 * 直向合併（跨 ≥2 列）的數量：即 expandVerticalMerges 真正會展開的那種。
 * 健檢的「已自動展開」提示只算這些——純橫向合併沒被展開，計入會誤報（明明沒展開卻說已展開）。
 */
export function countVerticalMerges(merges: MergeRange[]): number {
  return merges.filter(m => m.endRow - m.startRow >= 2).length
}

interface ValuesResponse {
  values?: string[][]
}

/**
 * 讀取一份 Google Sheet 並轉成知識卡。
 * 依 selectSheetsToRead 決定讀哪些分頁（gid 指定→單頁；否則 FAQ 頁優先、再退全部非說明頁），
 * 每個分頁各自「第一列表頭、第一欄標題」跑 rowsToCards，跨分頁彙總——與 Excel 上傳一致。
 */
export async function readGoogleSheetAsCards(
  ref: ParsedSheetRef,
  api: SheetsApiFn = sheetsApi,
): Promise<ReadSheetResult> {
  const targets = await selectSheetsToRead(ref.spreadsheetId, ref.gid, api)

  const cards: SheetCard[] = []
  const titles: string[] = []
  let mergeCount = 0
  const agg: SheetImportStats = {
    rowCount: 0, skippedNoTitle: 0, mergedRows: 0, truncatedByCap: false,
    duplicateTitles: [], blankAnswerTitles: [],
  }

  for (const t of targets) {
    if (cards.length >= GSHEET_MAX_ROWS) { agg.truncatedByCap = true; break }
    // 整個分頁（靠 range = 分頁名，A:Z 之外也讀）
    const data = await api<ValuesResponse>(
      `${encodeURIComponent(ref.spreadsheetId)}/values/${encodeURIComponent(t.title)}?majorDimension=ROWS`,
    )
    const rows = expandVerticalMerges(
      (data.values ?? []).map(r => (Array.isArray(r) ? r.map(c => String(c ?? '')) : [])),
      t.merges,
    )
    const { cards: sheetCards, stats } = rowsToCards(rows)
    if (!sheetCards.length) continue

    titles.push(t.title)
    mergeCount += countVerticalMerges(t.merges)
    agg.rowCount += stats.rowCount
    agg.skippedNoTitle += stats.skippedNoTitle
    agg.mergedRows += stats.mergedRows
    agg.truncatedByCap ||= stats.truncatedByCap
    agg.duplicateTitles.push(...stats.duplicateTitles)
    agg.blankAnswerTitles.push(...stats.blankAnswerTitles)
    for (const c of sheetCards) {
      if (cards.length >= GSHEET_MAX_ROWS) { agg.truncatedByCap = true; break }
      cards.push(c)
    }
  }

  if (!agg.rowCount) {
    throw createError({ statusCode: 422, statusMessage: '這份試算表沒有足夠資料（需要表頭列 + 至少一列資料）' })
  }

  return {
    cards,
    sheetTitle: titles.join('、') || targets[0]?.title || 'Sheet1',
    mergeCount,
    stats: agg,
  }
}

/** 標題正規化當比對 key（去空白、轉小寫）；gsheet 同步、匯入健檢、合併重複列共用這一份。 */
export function normTitle(s: string): string {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase()
}

/**
 * 一份「表格」（rows[0] = 表頭，其餘為資料）→ 一疊知識卡 + 匯入健檢統計。
 * Google Sheet 與上傳的 Excel 乾淨表格共用同一套一列一卡邏輯，確保兩邊結果一致。
 * - 過濾整列皆空的列；有效資料列不足 2（表頭 + 至少一列）時回空。
 * - 第一欄（標題）空白的列會被略過（記 skippedNoTitle）。
 * - 同標題（含直向合併標題欄造成的重複）併成同一張卡，避免以標題為 key 的同步吃掉重複卡而漏答案（記 mergedRows）。
 * - 套用 GSHEET_MAX_ROWS 上限。
 */
export function rowsToCards(rawRows: string[][]): { cards: SheetCard[]; stats: SheetImportStats } {
  const rows = (rawRows ?? []).filter(r => Array.isArray(r) && r.some(c => String(c ?? '').trim()))
  const emptyStats: SheetImportStats = {
    rowCount: 0, skippedNoTitle: 0, mergedRows: 0, truncatedByCap: false,
    duplicateTitles: [], blankAnswerTitles: [],
  }
  if (rows.length < 2) return { cards: [], stats: emptyStats }

  const headers = rows[0]!.map(h => String(h ?? '').trim())
  const dataRows = rows.slice(1)

  const cards: SheetCard[] = []
  const byKey = new Map<string, SheetCard>()
  const answered = new Set<string>() // 至少有一列填了答案的標題 key（用來精準判斷「沒答案」）
  const dupKeys = new Set<string>()
  let skippedNoTitle = 0
  let mergedRows = 0
  let truncatedByCap = false

  for (const row of dataRows) {
    const parsed = rowToCardParsed(headers, row)
    if (!parsed) { skippedNoTitle++; continue } // 第一欄空白 → 沒標題，略過
    const { card, hasAnswer } = parsed
    const key = normTitle(card.title)
    if (hasAnswer) answered.add(key)

    const existing = byKey.get(key)
    if (existing) {
      // 同標題（直向合併的標題欄、或商家重複填）→ 併入同一張卡，不另建重複卡。
      // title 是同步比對 key，重複卡本來就會被同步收斂而漏掉答案；合併才不會漏。
      mergedRows++
      dupKeys.add(key)
      const add = card.content.trim()
      if (hasAnswer && add && !existing.content.includes(add)) {
        existing.content = `${existing.content}\n${add}`.slice(0, CARD_CONTENT_MAX)
      }
      continue
    }

    if (cards.length >= GSHEET_MAX_ROWS) { truncatedByCap = true; break }
    byKey.set(key, card)
    cards.push(card)
  }

  const stats: SheetImportStats = {
    rowCount: dataRows.length,
    skippedNoTitle,
    mergedRows,
    truncatedByCap,
    duplicateTitles: [...dupKeys].map(k => byKey.get(k)!.title),
    // 沒答案 = 這張卡的所有來源列都沒填答案（比 content === title 精準：避免答案剛好等於問題的誤判，
    // 也不受標題 > 200 字截斷影響）
    blankAnswerTitles: cards.filter(c => !answered.has(normTitle(c.title))).map(c => c.title),
  }
  return { cards, stats }
}

/**
 * 一列 → { 卡, 是否有填答案 }。第一欄（標題）空白回 null。
 * - 兩欄表（問/答 FAQ）：content = 第二欄整段。
 * - 多欄表：content = 其餘各欄「表頭：值」逐行列出（空值欄略過）。
 * - 答案欄全空時 content 以標題暫代（validateChunkInput 要求 content 非空），並標記 hasAnswer=false。
 */
function rowToCardParsed(headers: string[], row: string[]): { card: SheetCard; hasAnswer: boolean } | null {
  const title = String(row[0] ?? '').trim()
  if (!title) return null

  let content: string
  if (headers.length <= 2 || row.length <= 2) {
    content = String(row[1] ?? '').trim()
  }
  else {
    const pairs: string[] = []
    for (let i = 1; i < row.length; i++) {
      const v = String(row[i] ?? '').trim()
      if (!v) continue
      const h = String(headers[i] ?? '').trim()
      pairs.push(h ? `${h}：${v}` : v)
    }
    content = pairs.join('\n')
  }

  return {
    card: {
      title: title.slice(0, 200),
      content: (content || title).slice(0, CARD_CONTENT_MAX),
      tags: [],
    },
    hasAnswer: !!content,
  }
}

/** 一列 → 一張卡（薄包裝；供既有呼叫端／測試使用）。 */
export function rowToCard(headers: string[], row: string[]): SheetCard | null {
  return rowToCardParsed(headers, row)?.card ?? null
}

// ── 匯入前健檢 ──────────────────────────────────────────────────────

export interface SheetImportStats {
  /** 有效資料列數（表頭以下、至少一格非空） */
  rowCount: number
  /** 第一欄（標題）空白被略過、未成卡的列數 */
  skippedNoTitle: number
  /** 標題與前面某列重複、被併入該卡的列數 */
  mergedRows: number
  /** 因達 GSHEET_MAX_ROWS 上限被截斷 */
  truncatedByCap: boolean
  /** 有重複標題（已合併）的卡標題，給健檢列舉 */
  duplicateTitles: string[]
  /** 答案欄空白（以標題暫代內容）的卡標題，給健檢列舉 */
  blankAnswerTitles: string[]
}

/** 健檢訊息裡列舉標題時最多列幾個（其餘用「等 N 列」帶過，避免訊息爆長） */
const HEALTH_LIST_MAX = 3

function listTitles(titles: string[]): string {
  const shown = titles.slice(0, HEALTH_LIST_MAX).map(t => `「${t}」`).join('、')
  return titles.length > HEALTH_LIST_MAX ? `${shown} 等 ${titles.length} 列` : shown
}

/**
 * 表格匯入的健檢：回傳「警告訊息」清單（顯示在預覽畫面，提醒但不擋匯入）。
 * 針對商家常踩的坑：示範列沒替換、重複問題（已合併）、沒答案、超量、空標題被略過、合併儲存格。
 * 訊號都由 rowsToCards 精算好（stats），這裡只組訊息——gsheet 與 xlsx 一列一卡共用。
 */
export function sheetHealthWarnings(cards: SheetCard[], stats: SheetImportStats, mergeCount = 0): string[] {
  const warnings: string[] = []

  const demo = cards.filter(c => c.content.includes('【示範答案')).map(c => c.title)
  if (demo.length) {
    warnings.push(`還有 ${demo.length} 列是範本的示範內容，記得替換：${listTitles(demo)}`)
  }

  if (stats.duplicateTitles.length) {
    warnings.push(`有重複的問題（標題），已自動合併成同一張卡，請確認內容：${listTitles(stats.duplicateTitles)}`)
  }

  if (stats.blankAnswerTitles.length) {
    warnings.push(`${stats.blankAnswerTitles.length} 列沒有答案內容（暫以問題原文當內容），建議補上答案：${listTitles(stats.blankAnswerTitles)}`)
  }

  if (stats.truncatedByCap) {
    warnings.push(`表格資料超過 ${GSHEET_MAX_ROWS} 列上限，只會匯入前 ${GSHEET_MAX_ROWS} 列`)
  }

  if (stats.skippedNoTitle > 0) {
    warnings.push(`有 ${stats.skippedNoTitle} 列因第一欄（標題）空白被略過、未匯入；請確認是否漏填標題`)
  }

  if (mergeCount > 0) {
    warnings.push(`偵測到 ${mergeCount} 處合併儲存格（已自動展開），請確認下方每張卡的內容正確；建議改為一列一題、不使用合併儲存格`)
  }

  return warnings
}
