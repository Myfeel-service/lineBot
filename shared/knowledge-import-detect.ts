/**
 * 匯入來源判別:使用者丟進來的東西是檔案、網址、Google 試算表,還是純文字。
 *
 * 為什麼是 shared 純函式:第一步從「四個分頁自己選」改成「丟進來自動判別」後,
 * 這條規則變成整個匯入流程的分岔點——判錯的後果不是顯示錯字,而是**把一串
 * 試算表 ID 當成知識內容匯進資料庫**。元件內的 computed 測不到,抽出來測。
 */

export type ImportKind = 'file' | 'url' | 'gsheet' | 'text'

/**
 * Google 試算表:完整網址,或裸的檔案 ID。
 * 裸 ID 要收:舊的分頁介面允許直接貼 ID,少了這條會被歸成純文字。
 * 純文字的知識內容不會是「單一個 20 字以上、不含空白與中文的 token」,誤判風險極低。
 */
export const GSHEET_PATTERN = /docs\.google\.com\/spreadsheets|^[a-zA-Z0-9-_]{20,}$/
export const HTTP_URL_PATTERN = /^https?:\/\/\S+$/i

/**
 * @param pasted 貼進投放區的文字（未 trim 也可）
 * @param hasFile 是否已經選了/拖了檔案（檔案優先）
 */
export function detectImportKind(pasted: string, hasFile = false): ImportKind {
  if (hasFile) return 'file'
  const v = String(pasted ?? '').trim()
  if (!v) return 'file' // 還沒給東西;呼叫端的「可以開始」判斷仍為 false
  // ⛔ 只有「裡面就這一個連結、而且是試算表」才算試算表（2026-10-13 `/code-review`）：GSHEET_PATTERN 沒有錨定，
  //    「https://shop.tw/faq https://docs.google.com/spreadsheets/…」以前整串被判成試算表——faq 那頁默默不見，
  //    兩個網址連在一起的字串還被存成那份試算表的網址。好幾個連結夾了試算表的由 detectSheetAmongUrls 另外講。
  //    旁邊夾幾個字（「價目表 https://docs.google.com/…」）照舊算試算表
  if (sheetLinkOf(v)) return 'gsheet'
  if (HTTP_URL_PATTERN.test(v)) return 'url'
  return 'text'
}

/** 試算表的網址（不含裸 ID：裸 ID 只在「整段就是它」時才算，否則句子裡一個長英文字會被當成試算表） */
const SHEET_LINK_PATTERN = /docs\.google\.com\/spreadsheets/
const BARE_SHEET_ID_PATTERN = /^[a-zA-Z0-9-_]{20,}$/

function linkTokens(pasted: string): string[] {
  return String(pasted ?? '').trim().split(/\s+/).filter(p => p && (HTTP_URL_PATTERN.test(p) || SHEET_LINK_PATTERN.test(p)))
}

/**
 * 輸入裡唯一的那個連結、而且它是 Google 試算表 → 回那個連結（呼叫端拿它當試算表網址，旁邊的字不帶進去）；
 * 整段就是一串試算表 ID 也算；否則回空字串。
 */
export function sheetLinkOf(pasted: string): string {
  const v = String(pasted ?? '').trim()
  if (BARE_SHEET_ID_PATTERN.test(v)) return v
  const links = linkTokens(v)
  return links.length === 1 && SHEET_LINK_PATTERN.test(links[0]!) ? links[0]! : ''
}

/**
 * 好幾個連結裡夾了 Google 試算表 → true。這種輸入不能開始：試算表有自己的一條路（要先確認讀不讀得到、之後每小時同步），
 * 混在一般網址裡會被當成網頁抓；當成一段文字又會把網址字串本身拿去整理。呼叫端要講「試算表連結請單獨貼」並鎖住開始鈕。
 */
export function detectSheetAmongUrls(pasted: string): boolean {
  const links = linkTokens(pasted)
  return links.length >= 2 && links.some(p => SHEET_LINK_PATTERN.test(p))
}

/**
 * 一次貼了好幾個網址（`D-124`，跟 Gemini Notebook 一樣：空白或換行隔開）→ 回網址清單；不是就回 null。
 *
 * ⛔ 以前這種輸入被 detectImportKind 判成「一段文字」：AI 會把網址字串本身當成知識內容整理，
 *    一個字都沒抓到網頁上的東西（`HTTP_URL_PATTERN` 只認整段就是一個網址）。
 * 條件要嚴：每一段都要是 http(s) 網址、至少兩個；夾了任何一段不是網址的字＝那是一段文字（例：「官網 https://…」）。
 * Google 試算表連結不收進來：它有自己的一條路（要先確認讀不讀得到），混在一般網址裡會被當網頁抓。
 * 同一個網址貼兩次只留一個。
 */
export function detectUrlList(pasted: string): string[] | null {
  const parts = String(pasted ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return null
  if (!parts.every(p => HTTP_URL_PATTERN.test(p) && !GSHEET_PATTERN.test(p))) return null
  return [...new Set(parts)]
}

/**
 * 匯入時選的種類 → 實際存進資料庫的來源型別。
 *
 * 只有「貼上一段文字」對不起來：它存成 `manual`（與手寫單卡同類，不排同步、不偵測變動）。
 * 抽成共用函式是因為這個對照現在有三個地方要用——建立來源、重複偵測、
 * 「更新既有那一份」的型別守門——各寫一份遲早會有一處忘了換，
 * 而錯掉的後果是**把一份 Google 試算表覆蓋成檔案**：型別變了、同步設定卻還留著，
 * 那份資料從此不再自動同步，畫面上完全看不出來（`C-139`）。
 */
export function storedSourceType(kind: ImportKind): 'file' | 'url' | 'gsheet' | 'manual' {
  return kind === 'text' ? 'manual' : kind
}

/**
 * 這一份既有資料，可不可以被這次匯入「更新」掉（`C-139`）。
 *
 * 同名警告列的是**名字相同**的所有資料，不分種類。上傳檔案時若按到一份 Google 試算表的
 * 「更新這一份」，那份資料的型別會被改成檔案、網址被清空，但試算表的分頁對應還留著——
 * 結果是**它從此不再自動同步**，而畫面上完全看不出來。
 *
 * `existingType` 空字串＝舊資料沒存型別，回 true 交給後端判（前端不該自己猜著擋）。
 */
export function canReplaceSource(kind: ImportKind, existingType: string): boolean {
  if (!existingType) return true
  return existingType === storedSourceType(kind)
}
