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
