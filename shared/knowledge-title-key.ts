/**
 * 「是不是同一條知識」的標題比對 key（去空白、轉小寫）。
 * 試算表同步、匯入健檢、合併重複列、換新版時「新版裡同名的那一條」（`D-125`①）都用這一份——
 * 伺服器（`server/utils/google-sheets.ts` 的 normTitle）跟加入視窗各寫一套的話，畫面說「新版也有這一條」、
 * 伺服器卻當成兩條，就會多收一條重複的。
 */
export function knowledgeTitleKey(s: string): string {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase()
}
