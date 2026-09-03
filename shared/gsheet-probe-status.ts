/**
 * 「我讀不讀得到這份 Google 試算表」的結果分類（`D-50` 簡化 4）。
 *
 * 抽成純函式的理由：分類決定使用者看到哪一句話、要不要去 Google 按分享，
 * 而它是從 Google 的原始錯誤訊息猜出來的——這種猜測一定要有測試釘住，
 * 否則哪天訊息換句話說，畫面就會叫人去按一個本來就分享好的分享鈕。
 */

export type GsheetProbeStatus =
  /** 讀得到 */
  | 'ok'
  /** 連結不是 Google 試算表 */
  | 'bad_url'
  /** 還沒把表分享給服務帳號（或 Sheets API 沒啟用）→ 去 Google 按分享 */
  | 'no_access'
  /** 讀得到但沒有資料可讀 → 去補資料或改貼對的分頁 */
  | 'no_data'
  /** 上傳的 Excel 檔沒轉成 Google 試算表 → 先轉檔 */
  | 'bad_file'
  /** 我們也不確定 → ⛔照實說，不可以假裝是「沒分享」 */
  | 'unknown'

/**
 * 照「使用者下一步該做什麼」分類，不是照 HTTP 碼分類。
 * @param raw 後端（google-sheets.ts）丟出來的 statusMessage 原文
 */
export function classifyGsheetProbeError(raw: string): { status: GsheetProbeStatus, needsShare: boolean } {
  const text = String(raw ?? '')
  if (/沒有足夠資料|沒有任何分頁|分頁已不存在/.test(text)) {
    return { status: 'no_data', needsShare: false }
  }
  // ⚠️ 這條要排在 no_access 前面：Excel 檔的訊息裡也有「分享給服務帳號」幾個字，
  //    順序顛倒的話會叫人一直去按分享，而真正要做的是先轉檔。
  if (/Office file|上傳的 Excel/.test(text)) {
    return { status: 'bad_file', needsShare: false }
  }
  if (/讀不到這份 Google Sheet|尚未在.*啟用|SERVICE_DISABLED/.test(text)) {
    return { status: 'no_access', needsShare: true }
  }
  return { status: 'unknown', needsShare: false }
}
