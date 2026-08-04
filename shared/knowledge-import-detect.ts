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
  if (GSHEET_PATTERN.test(v)) return 'gsheet'
  if (HTTP_URL_PATTERN.test(v)) return 'url'
  return 'text'
}
