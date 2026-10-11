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
  /**
   * 沒讀的分頁（使用說明頁等）；預覽要講「跳過了哪幾頁」。
   * Numbers 的「輸出摘要」不在這裡（放 stats.exportSummarySheets）：這裡的頁預覽會講成「看起來是使用說明」，
   * 對 Numbers 自己加的那頁講錯原因。
   */
  skippedSheets: string[]
  /** 有讀、但一條都沒整理出來的分頁（只有一欄、只有欄位名稱）；那頁的內容沒收進來，要講 */
  emptySheets: string[]
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
 * Apple Numbers 輸出成 Excel 時自己加在最前面的「輸出摘要」頁（各語言的名稱照 Numbers.app 的
 * TCCompatibility.strings「Export Summary」那一條抄來，2026-10-11 在本機 Numbers 實際輸出確認過繁中版）。
 * 那頁只有「此文件從 Numbers 輸出…」一段說明和一張分頁對照表——讀進來就是幾張「Numbers 工作表名稱」之類的怪卡。
 * 只認**整個名稱完全一樣**：店家自己取名的資料頁不會剛好叫這個。
 */
const NUMBERS_EXPORT_SUMMARY_NAMES = new Set([
  '輸出摘要', '导出摘要', 'export summary', '書き出しの概要', '내보내기 요약',
  'export-zusammenfassung', 'résumé de l’exportation', 'resumen de exportación', 'riepilogo di esportazione',
  'resumo da exportação', 'exportoverzicht', 'обзор экспорта', 'สรุปการส่งออก', 'xuất tổng kết',
  'ringkasan eksport', 'ekspor ringkasan', 'dışa aktarma özeti', 'podsumowanie eksportu',
])

export function isExportSummarySheetName(name: string): boolean {
  return NUMBERS_EXPORT_SUMMARY_NAMES.has(String(name ?? '').trim().toLowerCase())
}

/** 官方範本的資料頁叫「FAQ」；舊規則只讀這幾頁，探測也先看這幾頁 */
function isFaqSheetName(name: string): boolean {
  return /faq|常見問/i.test(String(name ?? ''))
}

/**
 * 決定要讀哪些分頁的「名稱」（Excel／CSV 上傳與 Google Sheet 共用同一套規則，確保兩邊結果一致）：
 * 1. 全部「非說明」分頁（跳過使用說明 / 教學頁、Numbers 的輸出摘要）。
 * 2. 保底：整份都是說明類名稱時，全讀（寧可多匯，也不要讓使用者面對空結果）——輸出摘要照樣不讀。
 *
 * legacy（舊規則）：名稱含 FAQ / 常見問 的分頁存在時只讀那幾頁，也不認輸出摘要——跟改版前一模一樣。
 * 2026-10-10 起新來源拿掉 FAQ 優先（`C-296`，老闆拍板「每個分頁都讀」）：照範本建好 FAQ 頁、
 * 自己再加一頁「價目表」的人，那一頁會整頁沒讀而且沒有人講。
 * ⛔ 但**已經在同步的舊試算表**要繼續用舊規則（呼叫端看來源有沒有 `gsheetTabRule`）——
 *    改規則的當下，下一輪同步就會把別頁的列整批變成新卡，店家什麼都沒做。
 * ⚠️ 新舊一定要呼叫端講明（沒有預設值）：預設值選錯哪一邊，都是另一邊安靜地讀錯。
 *
 * 註：Google Sheet 若連結帶 #gid= 指定分頁，由呼叫端優先處理（尊重使用者指定），不走這裡。
 */
export function selectDataSheetNames(names: string[], opts: { legacy: boolean }): string[] {
  if (opts.legacy) {
    const faq = names.filter(isFaqSheetName)
    if (faq.length) return faq
    const nonInstruction = names.filter(n => !isInstructionSheetName(String(n ?? '')))
    return nonInstruction.length ? nonInstruction : names
  }
  const real = names.filter(n => !isExportSummarySheetName(n))
  const nonInstruction = real.filter(n => !isInstructionSheetName(String(n ?? '')))
  if (nonInstruction.length) return nonInstruction
  return real.length ? real : names
}

/** 讀了哪些分頁、跳過哪些說明頁（給預覽講「跳過了哪幾頁」） */
export function skippedSheetNames(all: string[], read: string[]): string[] {
  const set = new Set(read)
  return all.filter(n => !set.has(n))
}

/**
 * 沒讀的分頁拆成兩種講（`C-296` 審查）：Numbers 的輸出摘要放進 stats（sheetHealthWarnings 講「Numbers 自動加的」），
 * 其餘留在 skippedSheets（預覽講「看起來是使用說明」）。混在一起的話，輸出摘要會被講成使用說明。
 */
export function splitSkippedSheets(all: string[], read: string[], stats: SheetImportStats): string[] {
  const skipped = skippedSheetNames(all, read)
  const summary = skipped.filter(isExportSummarySheetName)
  if (summary.length) stats.exportSummarySheets = summary
  return skipped.filter(n => !isExportSummarySheetName(n))
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
 * - 否則走 selectDataSheetNames（全部非說明頁；舊來源照舊 FAQ 頁優先）——與 Excel 上傳同規則。
 * 回傳的 allTitles 給呼叫端算「跳過了哪幾頁」。
 */
async function selectSheetsToRead(
  spreadsheetId: string,
  gid: string | null,
  api: SheetsApiFn,
  opts: { legacy: boolean },
): Promise<{ targets: Array<{ title: string; merges: MergeRange[] }>, allTitles: string[] }> {
  const meta = await api<SheetMeta>(
    `${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent('sheets(properties(sheetId,title),merges)')}`,
  )
  const sheets = meta.sheets ?? []
  if (!sheets.length) throw createError({ statusCode: 422, statusMessage: '這份試算表沒有任何分頁' })
  const allTitles = sheets.map(s => s.properties?.title ?? '')

  if (gid != null) {
    const hit = sheets.find(s => String(s.properties?.sheetId) === gid)
    // 指定了某一頁＝他自己選的，其他頁本來就不在範圍內，不算「跳過」
    if (hit) return { targets: [toSheetTarget(hit)], allTitles: [hit.properties?.title ?? ''] }
    // ⛔指定的分頁不見了（被刪除重建 gid 就會變）→ 直接失敗，不退回名稱猜測。
    // 退回猜測的下場：改讀到「使用說明」頁 → 說明文字變知識卡、原 FAQ 卡整批被判
    // 「表上已不存在」刪光——靜默讀錯頁比讀不到危險得多。
    throw createError({
      statusCode: 422,
      statusMessage: '原本指定的分頁已不存在（分頁被刪除重建時，連結裡的 gid 會變）。請確認試算表分頁，重新貼一次正確的分頁連結。',
    })
  }
  const pick = new Set(selectDataSheetNames(allTitles, opts))
  const selected = sheets.filter(s => pick.has(s.properties?.title ?? ''))
  return { targets: (selected.length ? selected : sheets).map(toSheetTarget), allTitles }
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

/** 這一頁有沒有任何一格有字（整頁空白的「工作表2」不值得提醒，有字卻整理不出來的才要講） */
function hasAnyText(rows: string[][]): boolean {
  return rows.some(r => Array.isArray(r) && r.some(c => String(c ?? '').trim()))
}

/**
 * 讀取一份 Google Sheet 並轉成知識卡。
 * 依 selectSheetsToRead 決定讀哪些分頁（gid 指定→單頁；否則全部非說明頁，舊來源 FAQ 頁優先），
 * 每個分頁各自跑 rowsToCards（欄位名稱那列自己找），跨分頁彙總——與 Excel 上傳一致。
 * opts.legacy：已經在同步的舊試算表（來源沒有 gsheetTabRule）要帶 true——分頁、每一列、跨分頁怎麼收
 * **全部照改版前**（見 rowsToCards、createCardCollector）。
 * ⛔ 連「不同分頁同標題併成一張」也不對舊來源做（2026-10-11 審查）：舊表價目表、規格表都有 W1 時，
 *    改版前同步只認第一頁那一列（`W1:"12,900"`）；替它併成 `"12,900\n12L"`＝上線後第一輪同步就改寫
 *    店家的知識、再付一次 AI 補問法，店家什麼都沒做。
 */
export async function readGoogleSheetAsCards(
  ref: ParsedSheetRef,
  api: SheetsApiFn = sheetsApi,
  opts: { legacy?: boolean } = {},
): Promise<ReadSheetResult> {
  const legacy = opts.legacy === true
  const { targets, allTitles } = await selectSheetsToRead(ref.spreadsheetId, ref.gid, api, { legacy })

  const collector = createCardCollector({ legacy })
  const titles: string[] = []
  const emptySheets: string[] = []
  let mergeCount = 0

  for (const t of targets) {
    // 舊讀法：滿了就不讀後面的分頁（跟以前一樣）。新讀法照讀：後面分頁的同名列還要併進已收的那幾條
    if (legacy && collector.full()) { collector.stats.truncatedByCap = true; break }
    // 整個分頁（靠 range = 分頁名，A:Z 之外也讀）
    const data = await api<ValuesResponse>(
      `${encodeURIComponent(ref.spreadsheetId)}/values/${encodeURIComponent(t.title)}?majorDimension=ROWS`,
    )
    const rows = expandVerticalMerges(
      (data.values ?? []).map(r => (Array.isArray(r) ? r.map(c => String(c ?? '')) : [])),
      t.merges,
    )
    // values 從 A1 起算（前面的空白列也會回空陣列），第 i 個就是試算表的第 i+1 列
    const { cards: sheetCards, stats } = rowsToCards(rows, { legacy, firstRow: 1 })
    if (!sheetCards.length) {
      // 跟 Excel 同一套（`C-296` 審查）：整頁空白不講，有字卻一條都整理不出來的才講
      if (hasAnyText(rows)) emptySheets.push(t.title)
      continue
    }

    titles.push(t.title)
    mergeCount += countVerticalMerges(t.merges)
    collector.addSheet(sheetCards, stats, t.title)
  }

  if (!collector.stats.rowCount) {
    throw createError({ statusCode: 422, statusMessage: '這份試算表沒有足夠資料（需要表頭列 + 至少一列資料）' })
  }

  const readTitles = targets.map(t => t.title)
  return {
    cards: collector.cards,
    sheetTitle: titles.join('、') || targets[0]?.title || 'Sheet1',
    mergeCount,
    stats: collector.stats,
    skippedSheets: legacy ? skippedSheetNames(allTitles, readTitles) : splitSkippedSheets(allTitles, readTitles, collector.stats),
    emptySheets,
  }
}

/**
 * 把各分頁的卡收成一疊（Google Sheet 與 Excel 共用）。新舊讀法一定要講明（沒有預設值，見 selectDataSheetNames）。
 *
 * 新讀法：
 * ⛔ **不同分頁同一個標題要併成一張**（2026-10-10 審查實測）：價目表與規格表都有「W1」時，
 *    匯入會建兩張同名卡，而同步是照標題配對——第一次同步就拿其中一頁的內容蓋掉另一頁那張，
 *    哪一張被蓋看順序，店家完全看不出來。照同一頁內的規矩併起來，並列進「重複的標題」提醒。
 * ⛔ 沒填答案的那一列不併內容（2026-10-11 審查）：它的內容只是拿名稱暫代，併進去會多一行「W1」；
 *    先遇到沒答案、後面分頁才有答案的，直接換成有答案的那份。「沒答案」清單最後重算——
 *    別頁補到答案的就不算沒答案。
 * ⛔ 滿 150 條之後只是不收「新的名稱」，同名的照樣併（以前 break 掉，後面同名列的內容就沒了）。
 *
 * 舊讀法（legacy）：跟改版前一模一樣——不跨頁合併、照順序收到滿為止。
 */
export function createCardCollector(opts: { legacy: boolean }) {
  const legacy = opts?.legacy === true
  const cards: SheetCard[] = []
  const byKey = new Map<string, SheetCard>()
  const answered = new Set<string>()
  const dropped = new Set<string>()
  const stats = emptySheetStats()
  return {
    cards,
    stats,
    full: () => cards.length >= GSHEET_MAX_ROWS,
    addSheet(sheetCards: SheetCard[], sheetStats: SheetImportStats, sheetName?: string) {
      mergeSheetStats(stats, sheetStats)
      if (legacy) {
        for (const c of sheetCards) {
          if (cards.length >= GSHEET_MAX_ROWS) { stats.truncatedByCap = true; break }
          cards.push(c)
        }
        return
      }

      stats.sheetsRead = (stats.sheetsRead ?? 0) + 1
      for (const ex of sheetStats.continuedExamples ?? []) {
        (stats.continuedExamples ??= []).push({ ...ex, sheet: sheetName })
      }
      const blank = new Set(sheetStats.blankAnswerTitles.map(normTitle))
      for (const c of sheetCards) {
        const key = normTitle(c.title)
        const hasAnswer = !blank.has(key)
        const existing = byKey.get(key)
        if (existing) {
          if (hasAnswer) {
            existing.content = answered.has(key) ? appendNewLines(existing.content, c.content) : c.content
            answered.add(key)
          }
          if (!stats.duplicateTitles.includes(existing.title)) stats.duplicateTitles.push(existing.title)
          continue
        }
        if (cards.length >= GSHEET_MAX_ROWS) { dropped.add(key); continue }
        byKey.set(key, c)
        cards.push(c)
        if (hasAnswer) answered.add(key)
      }
      // 這一頁自己就收滿、沒收進來的名稱（已經在別頁收過的不算沒收：那只是少併一列）
      for (const k of sheetStats.cappedOut ?? []) if (!byKey.has(k)) dropped.add(k)
      stats.truncatedByCap = dropped.size > 0
      stats.droppedByCap = dropped.size
      stats.blankAnswerTitles = cards.filter(c => !answered.has(normTitle(c.title))).map(c => c.title)
      // 同一個名稱在兩頁各自重複時，每頁都會報一次；提醒只列一次
      const dupByKey = new Map<string, string>()
      for (const t of stats.duplicateTitles) if (!dupByKey.has(normTitle(t))) dupByKey.set(normTitle(t), t)
      stats.duplicateTitles = [...dupByKey.values()]
    },
  }
}

/** 空的健檢統計（各分頁加總的起點）；欄位一多就容易漏一個，集中一處 */
export function emptySheetStats(): SheetImportStats {
  return {
    rowCount: 0, skippedNoTitle: 0, mergedRows: 0, truncatedByCap: false,
    duplicateTitles: [], blankAnswerTitles: [], titleRows: [], continuedRows: 0,
  }
}

/**
 * 把一個分頁的健檢統計加進總數（Google Sheet 與 Excel 共用）。
 * 只加「每頁各自算」的那幾格；跨頁才算得準的（沒答案、超過上限、重複）由 createCardCollector 收尾時重算。
 */
export function mergeSheetStats(agg: SheetImportStats, s: SheetImportStats): void {
  agg.rowCount += s.rowCount
  agg.skippedNoTitle += s.skippedNoTitle
  agg.mergedRows += s.mergedRows
  agg.truncatedByCap ||= s.truncatedByCap
  agg.duplicateTitles.push(...s.duplicateTitles)
  agg.blankAnswerTitles.push(...s.blankAnswerTitles)
  agg.titleRows.push(...(s.titleRows ?? []))
  agg.continuedRows += s.continuedRows ?? 0
  if (s.serialColumns?.length) (agg.serialColumns ??= []).push(...s.serialColumns)
}

/**
 * 「我現在讀不讀得到這份試算表」的**有界**探測（`D-50` 簡化 4）。
 *
 * 與 readGoogleSheetAsCards 的差別只有讀多少：那支為了真的匯入，會把每個分頁整份讀完
 * （5,000 列的商品表就是 5,000 列）；這支只為了回答「讀得到嗎／有資料嗎」，
 * 所以只讀第一個目標分頁的前 PROBE_ROWS 列。
 * ⛔ 不可以退成「只讀 metadata」：那樣「分享好了但那個分頁是空的」會過綠燈，
 *    然後在按下整理時撞 422——正是這個探測要消滅的撞牆。
 * ⛔ 回傳刻意**不含總列數**：只看前 20 列算不出全表有幾列，報一個算錯的數字比不報更糟。
 */
const PROBE_ROWS = 20

/** 探測最多看幾個分頁有沒有資料（每頁一次 API 往返；匯入時才全部讀） */
const PROBE_MAX_SHEETS = 5

export interface SheetProbeResult {
  /** 找到資料的那一頁；都沒找到時是第一個會讀的分頁 */
  sheetTitle: string
  /** 匯入時會讀的全部分頁 */
  sheetTitles: string[]
  /** 這次**真的看過**的分頁（照看的順序）；講「哪幾頁沒資料」只能講這幾頁 */
  checkedTitles: string[]
  hasData: boolean
}

export async function probeGoogleSheetAccess(
  ref: ParsedSheetRef,
  api: SheetsApiFn = sheetsApi,
): Promise<SheetProbeResult> {
  // 探測是替「新匯入」回答的，照新讀法挑分頁（舊來源不會再走探測）
  const { targets } = await selectSheetsToRead(ref.spreadsheetId, ref.gid, api, { legacy: false })
  if (!targets.length) throw createError({ statusCode: 422, statusMessage: '這份試算表沒有任何分頁' })
  const sheetTitles = targets.map(t => t.title)
  // 匯入會讀每一個非說明頁（`C-296`）：第一頁是空白封面不代表整份沒資料。
  // ⛔ 名稱像 FAQ 的頁先看（2026-10-11 審查）：複製範本的人前面常有封面、目錄好幾頁，
  //    照順序只看前幾頁會在 FAQ 頁明明有資料時亮紅燈。
  const ordered = [...targets.filter(t => isFaqSheetName(t.title)), ...targets.filter(t => !isFaqSheetName(t.title))]
  const checkedTitles: string[] = []
  for (const t of ordered.slice(0, PROBE_MAX_SHEETS)) {
    const data = await api<ValuesResponse>(
      `${encodeURIComponent(ref.spreadsheetId)}/values/${encodeURIComponent(`${t.title}!A1:Z${PROBE_ROWS}`)}?majorDimension=ROWS`,
    )
    checkedTitles.push(t.title)
    const rows = expandVerticalMerges(
      (data.values ?? []).map(r => (Array.isArray(r) ? r.map(c => String(c ?? '')) : [])),
      t.merges,
    )
    // 用同一支 rowsToCards 判「有沒有資料」：表頭列 + 至少一列資料才算
    if (rowsToCards(rows, { legacy: false }).stats.rowCount > 0) {
      return { sheetTitle: t.title, sheetTitles, checkedTitles, hasData: true }
    }
  }
  return { sheetTitle: targets[0]!.title, sheetTitles, checkedTitles, hasData: false }
}

/** 標題正規化當比對 key（去空白、轉小寫）；gsheet 同步、匯入健檢、合併重複列共用這一份。 */
export function normTitle(s: string): string {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase()
}

/** 表格最上面最多跳過幾列「標題列」（例：「2026 秋季價目表」＋「單位：新台幣」） */
const MAX_TITLE_ROWS = 3

const filledCount = (r: string[]) => r.filter(c => String(c ?? '').trim()).length

/** 這一列實際用到幾欄（最後一個有字的格子在第幾欄；中間空著的也算） */
function filledWidth(r: string[]): number {
  for (let i = r.length - 1; i >= 0; i--) if (String(r[i] ?? '').trim()) return i + 1
  return 0
}

/** 中日韓字算兩格寬：欄位名稱的長度限制要讓「Product Name (English)」跟「商品名稱」一樣過得去 */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += ch.codePointAt(0)! > 0x2E7F ? 2 : 1
  return w
}

/** 欄位名稱最寬多寬（中文約 15 字、英文約 30 字）；再長多半是一句答案 */
const HEADER_CELL_MAX_WIDTH = 30

/**
 * 這一格「明顯是資料、不會是欄位名稱」：
 * - 有問號（「退貨多久?」）、有句子的標點（「七天內可退，需附發票」）；
 * - 有數字，而且拿掉年份之後還有數字（價格 12,900、容量 12L、型號 W1、「7天內」）——
 *   ⚠️ 年份放行（2026-10-11 審查）：「2026 售價」是很常見的欄位名稱，以前被這條擋掉，
 *      欄位名稱那一列整列不認、退回去拿表格標題當欄位名稱；
 * - 只有數字（單獨一格「2026」）。
 * ⚠️ 沒有比照審查建議放寬成「只有純數字才算資料」：那樣「W1 mini｜小台｜白色」這種第一筆資料
 *    會被當成欄位名稱吃掉（少一筆資料，比少幾個欄位名稱嚴重）。認不出欄位名稱時不會掉資料，見 rowsToCards。
 * ⛔ 只有符號、沒有數字的格（「#」「＃」「※」）**不算資料**：流水號那一欄的欄位名稱常常就寫一個「#」。
 *    2026-10-11 拿本機真的試算表比對抓到：以前把「沒有字母」當成資料，整列欄位名稱因為那一格「#」不認，
 *    上面那行表格標題變成欄位名稱——每一條都少了欄位名稱、欄位名稱那一列還變成一張叫「#」的卡。
 */
function looksLikeDataCell(c: string): boolean {
  if (/[?？]/.test(c)) return true
  if (/[。！!；;，]/.test(c)) return true
  const withoutYears = c.replace(/(?<![\d０-９])(?:19|20)\d{2}(?![\d０-９])/g, '')
  if (/[\d０-９]/.test(withoutYears)) return true
  return /[\d０-９]/.test(c) && !/\p{L}/u.test(withoutYears)
}

/** 「看起來像欄位名稱」：每格都不長、沒有一格明顯是資料（見 looksLikeDataCell） */
function looksLikeHeaderRow(cells: string[]): boolean {
  return cells
    .map(c => String(c ?? '').trim())
    .filter(Boolean)
    .every(c => displayWidth(c) <= HEADER_CELL_MAX_WIDTH && !looksLikeDataCell(c))
}

/**
 * 找欄位名稱在哪一列（`C-296`）。以前一律當第 1 列——最上面有一行表格標題時，
 * 「2026 秋季價目表」被當成欄位名稱，後面每一條都少了「容量」「價格」這幾個字，
 * 還多出一張叫「品名」的怪卡。
 *
 * 只在**三欄以上的表**才找：最上面連續幾列（最多 3 列）都只有一格有字，而且緊接著那一列
 * 三格以上有字、看起來像欄位名稱（見 looksLikeHeaderRow），才把上面那幾列當標題跳過。
 * ⛔ 兩欄表（問題／答案）**一律不跳**：兩欄表的內容就是第二欄、欄位名稱根本用不到，
 *    跳了只會冒險把第一筆資料當成欄位名稱吃掉（2026-10-10 審查實測：合併的「常見問題 Q&A」
 *    標題下面直接接資料，第一題整題不見）。
 * ⛔ 下一列像資料（有問號、有年份以外的數字）就不跳：「問題」只填一格、下面直接是「退貨?｜7天內｜需發票」的表，
 *    跳了會吃掉第一筆。寧可沿用舊行為（少幾個欄位名稱），也不要少一筆資料。
 *    不跳的時候也不會掉資料：一列有幾欄是看整張表最寬那一列（見 rowsToCards），不是看拿來當欄位名稱的那一列。
 * 回傳的 titles／header 一定要講給使用者聽（見 sheetHealthWarnings）——猜的要說出來。
 */
function locateHeaderRow(
  rows: Array<{ cells: string[], index: number }>,
): { headerAt: number, titles: string[] } {
  const none = { headerAt: 0, titles: [] as string[] }
  const widest = rows.reduce((m, r) => Math.max(m, filledCount(r.cells)), 0)
  if (widest < 3) return none
  let h = 0
  while (h < MAX_TITLE_ROWS && h < rows.length - 1 && filledCount(rows[h]!.cells) === 1) h++
  if (h === 0 || h >= rows.length - 1) return none
  const header = rows[h]!.cells
  if (filledCount(header) < 3 || !looksLikeHeaderRow(header)) return none
  return {
    headerAt: h,
    titles: rows.slice(0, h).map(r => String(r.cells.find(c => String(c ?? '').trim()) ?? '').trim()),
  }
}

/**
 * 併進同一張卡時只加「還沒有的那幾行」。
 * ⛔ 不可以用整段 `includes` 判斷：延續列「價格：12」會因為上面有「價格：12,900」被當成重複丟掉。
 */
function appendNewLines(existing: string, add: string): string {
  const have = new Set(existing.split('\n').map(l => l.trim()))
  const fresh = add.split('\n').map(l => l.trim()).filter(l => l && !have.has(l))
  return fresh.length ? `${existing}\n${fresh.join('\n')}`.slice(0, CARD_CONTENT_MAX) : existing
}

/**
 * 一份「表格」→ 一疊知識卡 + 匯入健檢統計。
 * Google Sheet 與上傳的 Excel／CSV 共用同一套一列一卡邏輯，確保兩邊結果一致。
 * - 過濾整列皆空的列；有效資料列不足 2（表頭 + 至少一列）時回空。
 * - 欄位名稱那一列自己找（最上面的表格標題會跳過，見 locateHeaderRow）。
 * - 第一欄空白的列＝上一列的延續（同一個商品的第二行規格），併進上一張卡（記 continuedRows）。
 *   以前是整列略過。一開頭就空白、上面沒有列可接的，照舊略過（記 skippedNoTitle）。
 * - 同標題（含直向合併標題欄造成的重複）併成同一張卡，避免以標題為 key 的同步吃掉重複卡而漏答案（記 mergedRows）。
 *   新讀法：先遇到的那列沒填答案、後面那列才有的，直接換成有答案的內容（不留一行只有名稱的「W1」）。
 * - 套用 GSHEET_MAX_ROWS 上限。新讀法滿了之後只是不收新的名稱，同名的列照樣併進去（記 cappedOut）。
 * - 兩欄還是多欄，新讀法看**整張表最寬那一列**（含欄位名稱那列）：欄位名稱那一列認錯、只剩一格時，
 *   以前會被當成兩欄表、只留第二欄（「W1｜12L｜12,900」的價格整欄不見）。
 *
 * opts.legacy＝**2026-10-10 以前就在同步的 Google 試算表**（來源沒有 gsheetTabRule）：
 * 欄位名稱一律第 1 列、第一欄空白照舊略過、合併照舊整段比對、短列照舊只取第二欄、滿了就停——**跟以前一模一樣**。
 * ⛔ 不可以替舊來源換讀法：同步會拿新讀法的結果去比舊卡，店家什麼都沒做，下一個小時知識就被改寫
 *    （2026-10-10 審查實測：舊表一行標題＋資料，第一題會被當成欄位名稱、同步時被刪掉）。
 * opts.firstRow＝rawRows[0] 在試算表上是第幾列（Excel 的資料不一定從第 1 列開始）；提醒裡講的列號要對得上他看到的。
 */
export function rowsToCards(
  rawRows: string[][],
  opts: { legacy?: boolean, firstRow?: number } = {},
): { cards: SheetCard[]; stats: SheetImportStats } {
  const legacy = opts.legacy === true
  const firstRow = opts.firstRow ?? 1
  const indexed = (rawRows ?? [])
    .map((cells, index) => ({ cells: Array.isArray(cells) ? cells : [], index }))
    .filter(r => r.cells.some(c => String(c ?? '').trim()))
  if (indexed.length < 2) return { cards: [], stats: emptySheetStats() }

  const { headerAt, titles: titleRows } = legacy ? { headerAt: 0, titles: [] as string[] } : locateHeaderRow(indexed)
  const headers = indexed[headerAt]!.cells.map(h => String(h ?? '').trim())
  let dataRows = indexed.slice(headerAt + 1)
  // 第一欄是 1、2、3… 流水號（新讀法才看）：拿它當名稱的話每一條都叫「1」「2」，而且**不同分頁的「1」會被當成同一項併在一起**
  // （2026-10-11 拿本機真的試算表比對：66 條裡 30 條名稱是數字，「1」那條混了兩張不相干的表）。改用下一欄當名稱（見 retitleSerialRows）
  const serialColumns: string[] = []
  const retitled = legacy ? null : retitleSerialRows(dataRows)
  if (retitled) {
    serialColumns.push(headers[0] ?? '')
    dataRows = retitled
  }
  // ⚠️ 用 reduce 不用 Math.max(...)：10 萬列展開成參數會爆堆疊
  const mode: RowReadMode = legacy
    ? { legacy: true }
    : { legacy: false, tableWidth: dataRows.reduce((m, r) => Math.max(m, filledWidth(r.cells)), filledWidth(headers)) }
  // 延續列提醒裡怎麼稱呼第一欄：欄位名稱那一列真的是欄位名稱（至少兩格有字）才用它的第一格
  const nameLabel = !legacy && filledCount(headers) >= 2 ? headers[0] ?? '' : ''

  const cards: SheetCard[] = []
  const byKey = new Map<string, SheetCard>()
  const answered = new Set<string>() // 至少有一列填了答案的標題 key（用來精準判斷「沒答案」）
  const dupKeys = new Set<string>()
  const cappedOut = new Set<string>()
  const continuedExamples: ContinuedRowExample[] = []
  let skippedNoTitle = 0
  let mergedRows = 0
  let continuedRows = 0
  let truncatedByCap = false
  let lastTitle = ''

  for (const { cells: raw, index } of dataRows) {
    let row = raw
    let continued = false
    if (!legacy && !String(row[0] ?? '').trim() && lastTitle) {
      // 第一欄空白＝接著上一列講（例：W1 的第二行規格只寫在後面幾欄）。
      // ⛔ 開頭第一列就空白、上面沒有可以接的：照舊略過並計數（sheetHealthWarnings 會講），
      //    拿後面某一格硬當標題只會生出「標題叫 12L」的怪卡。
      row = [lastTitle, ...row.slice(1)]
      continued = true
    }
    const title = String(row[0] ?? '').trim().slice(0, 200)
    if (!title) { skippedNoTitle++; continue }
    // ⚠️ 收滿之後的列也要記 lastTitle：沒收進來的那一項的延續列，不可以接到上一個收進來的項目
    lastTitle = title
    const key = normTitle(title)
    const existing = byKey.get(key)

    if (!existing && cards.length >= GSHEET_MAX_ROWS) {
      truncatedByCap = true
      if (legacy) break
      cappedOut.add(key)
      continue
    }

    const { card, hasAnswer } = rowToCardParsed(headers, row, mode)!
    const hadAnswer = answered.has(key)
    if (hasAnswer) answered.add(key)

    if (existing) {
      // 同標題（直向合併的標題欄、第一欄空白的延續列、或商家重複填）→ 併入同一張卡，不另建重複卡。
      // title 是同步比對 key，重複卡本來就會被同步收斂而漏掉答案；合併才不會漏。
      // 延續列是商家本來就這樣排的，不算「重複」，不進重複提醒。
      if (continued) {
        continuedRows++
        if (continuedExamples.length < HEALTH_LIST_MAX) {
          continuedExamples.push({ row: firstRow + index, into: existing.title, label: nameLabel })
        }
      }
      else {
        mergedRows++
        dupKeys.add(key)
      }
      const add = card.content.trim()
      if (hasAnswer && add) {
        if (legacy) {
          if (!existing.content.includes(add)) existing.content = `${existing.content}\n${add}`.slice(0, CARD_CONTENT_MAX)
        }
        else {
          // 先前那幾列都沒答案＝內容只是拿名稱暫代，直接換掉（不留一行「W1」）
          existing.content = hadAnswer ? appendNewLines(existing.content, add) : add.slice(0, CARD_CONTENT_MAX)
        }
      }
      continue
    }

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
    titleRows,
    continuedRows,
    // 新讀法才有的幾格；舊讀法的統計維持改版前的樣子
    ...(legacy ? {} : { continuedExamples, cappedOut: [...cappedOut], ...(serialColumns.length ? { serialColumns } : {}) }),
  }
  return { cards, stats }
}

const SERIAL_CELL = /^\d{1,4}\.?$/
const hasLetter = (s: string) => /\p{L}/u.test(s)

/**
 * 第一欄是流水號（1、2、3…）的表，改用第二欄當名稱；不是就回 null（照舊）。
 *
 * 怎麼認：第一欄有字的格子八成以上是 1～4 位整數（表格底下夾幾列「註：…」也認得）、至少 3 個、從 1 開始往下不倒退、
 * 八成以上是一格加 1——貨號（1001、1002…）不從 1 開始，不會被當成流水號；第二欄六成以上是字（換了也沒比較好就不換）。
 * 怎麼換：⛔ 只換名稱、不刪任何一欄（第二欄照樣留在內容裡），不會少資料。
 *  - 第二欄每一列都不一樣 → 直接用它（「耶加雪菲」）；
 *  - 第二欄有重複（同一個平台好幾列）→ 用「序號. 名稱」（「4. 蝦皮購物」）。2026-10-11 本機真實檔實測：直接用會把
 *    不同列併成一條（11 條變 4 條），流水號本來就是用來分開它們的。
 *  - 那一列第二欄沒有字 → 留流水號。第一欄不是數字的列（註記）不動。
 */
function retitleSerialRows<T extends { cells: string[] }>(rows: T[]): T[] | null {
  const first = rows.map(r => String(r.cells[0] ?? '').trim())
  const isSerial = first.map(v => SERIAL_CELL.test(v))
  const filled = first.filter(Boolean).length
  const nums = first.filter((_, i) => isSerial[i]).map(v => Number.parseInt(v, 10))
  if (nums.length < 3 || nums.length / filled < 0.8 || nums[0] !== 1) return null
  let plusOne = 0
  for (let i = 1; i < nums.length; i++) {
    if (nums[i]! < nums[i - 1]!) return null
    if (nums[i] === nums[i - 1]! + 1) plusOne++
  }
  if (plusOne / (nums.length - 1) < 0.8) return null
  const names = rows.filter((_, i) => isSerial[i]).map(r => String(r.cells[1] ?? '').trim()).filter(hasLetter)
  if (names.length / nums.length < 0.6) return null
  const unique = new Set(names.map(normTitle)).size === names.length
  return rows.map((r, i) => {
    const name = String(r.cells[1] ?? '').trim()
    if (!isSerial[i] || !hasLetter(name)) return r
    const title = unique ? name : `${Number.parseInt(first[i]!, 10)}. ${name}`
    return { ...r, cells: [title, ...r.cells.slice(1)] }
  })
}

/**
 * 一列怎麼讀（`C-296`）：新舊一定要講明（2026-10-11 審查：以前是 `legacy = true` 的預設參數，
 * 忘了傳就安靜地用舊讀法）。新讀法要帶整張表最寬幾欄（見 rowsToCards）。
 */
type RowReadMode = { legacy: true } | { legacy: false, tableWidth: number }

/**
 * 一列 → { 卡, 是否有填答案 }。第一欄（標題）空白回 null。
 * - 兩欄表（問/答 FAQ）：content = 第二欄整段。
 * - 多欄表：content = 其餘各欄「表頭：值」逐行列出（空值欄略過；那一欄沒有欄位名稱就只放值）。
 * - 答案欄全空時 content 以標題暫代（validateChunkInput 要求 content 非空），並標記 hasAnswer=false。
 * legacy（舊來源的讀法）：表頭兩欄以下、或**這一列**只有兩格，就只取第二欄。
 * 新讀法只看整張表最寬幾欄——Google 試算表會把列尾的空格剪掉，三欄表的「W1｜12L」那一列以前會變成
 * 只剩「12L」、少了「容量」；欄位名稱那一列認錯、只剩一格時，也不會因此只留第二欄。
 */
function rowToCardParsed(headers: string[], row: string[], mode: RowReadMode): { card: SheetCard; hasAnswer: boolean } | null {
  const title = String(row[0] ?? '').trim()
  if (!title) return null

  let content: string
  const twoColumn = mode.legacy ? headers.length <= 2 || row.length <= 2 : mode.tableWidth <= 2
  if (twoColumn) {
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

/**
 * 一列 → 一張卡（薄包裝；供測試使用）。讀法一定要講明（見 RowReadMode）；
 * 新讀法單看一列時，「整張表最寬」只能拿欄位名稱與這一列自己估。
 */
export function rowToCard(headers: string[], row: string[], opts: { legacy: boolean }): SheetCard | null {
  const mode: RowReadMode = opts.legacy
    ? { legacy: true }
    : { legacy: false, tableWidth: Math.max(filledWidth(headers), filledWidth(row)) }
  return rowToCardParsed(headers, row, mode)?.card ?? null
}

// ── 匯入前健檢 ──────────────────────────────────────────────────────

/** 第一欄空白、被併到上一項的那一列（講給使用者聽要講得出「第幾列併到哪一項」） */
export interface ContinuedRowExample {
  /** 試算表上的列號（從 1 起算，跟他打開檔案看到的一樣） */
  row: number
  /** 併到哪一項（上一項的名稱） */
  into: string
  /** 第一欄的欄位名稱（例：「品名」）；認不出欄位名稱時是空字串 */
  label: string
  /** 哪一個分頁（跨分頁收的時候才填） */
  sheet?: string
}

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
  /** 欄位名稱上面被當成「表格標題」跳過的列（例：「2026 秋季價目表」）；要講給使用者聽 */
  titleRows: string[]
  /** 第一欄空白、當成上一列延續併進去的列數 */
  continuedRows: number
  // ── 以下只有新讀法會填（舊來源的統計維持改版前的樣子）──
  /** 延續列的前幾個例子（最多 HEALTH_LIST_MAX 個；總數看 continuedRows） */
  continuedExamples?: ContinuedRowExample[]
  /** 這一頁收滿之後沒收進來的名稱（normTitle 過的 key）；跨頁去重後的總數在 droppedByCap */
  cappedOut?: string[]
  /** 收滿之後沒收進來幾條（不同名稱的條數，跨分頁去重） */
  droppedByCap?: number
  /** 跳過的 Numbers「輸出摘要」分頁（不是資料，Numbers 輸出成 Excel 時自己加的） */
  exportSummarySheets?: string[]
  /** 收了幾個分頁（大於 1 時，列號要帶分頁名稱才對得上） */
  sheetsRead?: number
  /** 第一欄是流水號、改用下一欄當名稱的那幾頁，記那一欄的欄位名稱（沒有就空字串）；要講給使用者聽 */
  serialColumns?: string[]
}

/** 健檢訊息裡列舉標題時最多列幾個（其餘用「等 N 列」帶過，避免訊息爆長） */
const HEALTH_LIST_MAX = 3

function listTitles(titles: string[]): string {
  const shown = titles.slice(0, HEALTH_LIST_MAX).map(t => `「${t}」`).join('、')
  return titles.length > HEALTH_LIST_MAX ? `${shown} 等 ${titles.length} 列` : shown
}

/**
 * 延續列要講得出「第幾列併到哪一項」（`C-296` 審查）：只講「有 2 列第一欄空白」的話，
 * 真的少填一個品名、整列被併進上一個商品的人，看不出是哪一列。
 */
function continuedRowsWarning(stats: SheetImportStats): string {
  const examples = stats.continuedExamples ?? []
  if (!examples.length) {
    return `有 ${stats.continuedRows} 列第一欄空白，已當成上一列的延續、併進同一條（例：同一個商品的第二行規格）`
  }
  const multiSheet = (stats.sheetsRead ?? 0) > 1
  const at = (e: ContinuedRowExample) => `${multiSheet && e.sheet ? `「${e.sheet}」` : ''}第 ${e.row} 列`
  const labels = new Set(examples.map(e => e.label))
  const label = labels.size === 1 ? [...labels][0]! : ''
  const what = label ? `沒有「${label}」` : '第一欄是空的'
  const tail = '；不對的話請補上再匯入一次'
  if (stats.continuedRows <= 1) return `${at(examples[0]!)}${what}，已併到上一項「${examples[0]!.into}」${tail}`
  const shown = examples.slice(0, HEALTH_LIST_MAX).map(e => `${at(e)}併到「${e.into}」`).join('、')
  const more = stats.continuedRows > HEALTH_LIST_MAX ? '等' : ''
  return `有 ${stats.continuedRows} 列${what}，已各自併到上一項：${shown}${more}${tail}`
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
    // 跨分頁去重後的條數（新讀法才算得出來）；舊統計沒有這格就只講上限
    const left = stats.droppedByCap ?? 0
    warnings.push(`表格資料超過 ${GSHEET_MAX_ROWS} 條上限，只會匯入前 ${GSHEET_MAX_ROWS} 條${left > 0 ? `（後面還有 ${left} 條沒收進來）` : ''}`)
  }

  if (stats.skippedNoTitle > 0) {
    warnings.push(`有 ${stats.skippedNoTitle} 列因第一欄（標題）空白被略過、未匯入；請確認是否漏填標題`)
  }

  // 自己找欄位名稱、自己接延續列（`C-296`）：猜的一定要講出來，猜錯他才有機會發現
  if (stats.titleRows?.length) {
    warnings.push(`表格最上面的${listTitles(stats.titleRows)}看起來是表格標題，欄位名稱改用下面那一列；不對的話請把欄位名稱移到第 1 列`)
  }
  if (stats.continuedRows > 0) {
    warnings.push(continuedRowsWarning(stats))
  }
  // 流水號那欄沒收（`C-296`）：猜的要講，猜錯（那欄其實有意義）他才知道去哪裡改
  if (stats.serialColumns?.length) {
    const named = stats.serialColumns.find(Boolean)
    warnings.push(`第一欄${named ? `「${named}」` : ''}是流水號（1、2、3…），改用下一欄當每一條的名稱（下一欄有重複的，名稱前面加序號）；不對的話請把名稱放在第一欄`)
  }
  if (stats.exportSummarySheets?.length) {
    warnings.push(`略過${stats.exportSummarySheets.map(n => `「${n}」`).join('、')}分頁（Numbers 輸出時自動加的說明頁，不是資料）`)
  }

  if (mergeCount > 0) {
    warnings.push(`偵測到 ${mergeCount} 處合併儲存格（已自動展開），請確認下方每張卡的內容正確；建議改為一列一題、不使用合併儲存格`)
  }

  return warnings
}
