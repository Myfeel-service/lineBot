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
  /** 還沒把表分享給服務帳號 → 去 Google 按分享 */
  | 'no_access'
  /**
   * 我們這邊的 Google 試算表功能沒開（Sheets API 沒啟用）→ 不是店家能修的，⛔ 不可以叫他去共用
   * （2026-10-13 `/code-review`：以前歸在 no_access，畫面只剩三步共用教學，他怎麼共用都不會成功，唯一講得出原因的原文還被藏起來）
   */
  | 'not_enabled'
  /** 讀得到但沒有資料可讀 → 去補資料或改貼對的分頁 */
  | 'no_data'
  /** 上傳的 Excel 檔沒轉成 Google 試算表 → 先轉檔 */
  | 'bad_file'
  /** 我們也不確定 → ⛔照實說，不可以假裝是「沒分享」 */
  | 'unknown'
  /**
   * 讀得到，只是看過的那幾頁前幾列都沒資料、還有分頁沒看 → 直接整理就會一起讀（畫面當「讀得到」，不是失敗）。
   * ⛔ 不可以借用 'unknown'：那是「猜不出原因的錯誤」，畫面會畫紅叉＋叫人去重新分享（2026-10-12 code review）
   */
  | 'partial'

/** 這幾種＝讀得到這份試算表（畫面打勾、不出「請共用給這個帳號」那一塊） */
export const GSHEET_PROBE_READABLE: readonly GsheetProbeStatus[] = ['ok', 'partial']

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
  // ⚠️ 要排在 no_access 前面：這是我們的設定問題，叫店家去共用只會讓他白忙
  if (/尚未在.*啟用|SERVICE_DISABLED/.test(text)) {
    return { status: 'not_enabled', needsShare: false }
  }
  // 2026-10-12 那句原文從「Google Sheet」改叫「Google 試算表」（文字審視）；舊說法留著，免得哪裡還存著舊句子就分錯
  if (/讀不到這份 Google (?:Sheet|試算表)/.test(text)) {
    return { status: 'no_access', needsShare: true }
  }
  return { status: 'unknown', needsShare: false }
}
