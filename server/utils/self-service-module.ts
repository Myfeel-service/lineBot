import type { ModuleType } from '~~/shared/types/conversation-stats'

/**
 * 等真人期間（待真人／真人處理中），客人按到這個模組要不要照樣回（`D-31`，老闆 2026-10-20「照建議」）。
 *
 * 原則仍是「轉真人之後機器人閉嘴、真人會接」——但那把「查訂單、出貨進度說明、商品目錄」這種
 * **客人自己就能查完**的按鈕也一起關掉了：2026-08-24 那位客人等真人時 41 秒連按 34 次
 * （訂單問題 30、商品目錄 1），一則都沒回（`H-19`）。所以：
 *   ✅ 自助模組 → 照樣回（跟平常按下去一模一樣的內容）
 *   ⛔ 按下去就會轉真人的（「真人客服」模組）→ 不回模組，等真人期間只給一句節流過的「已經幫您安排專員」
 *   ⛔ 要客人接著打字回答的（模組裡有「請輸入…」那一步）→ 不回：他打的答案機器人在等真人期間不會接，
 *      而且那個「等他回答」的狀態會留 24 小時，真人交還之後客人隨便講一句都會被當成那題的答案
 *   ⛔ 打字 → 照舊閉嘴（不經過這裡）
 *
 * ⚠️ 「轉真人動作」指的是**按下這個模組本身會不會轉真人**，⛔ 不是「模組裡有沒有一顆真人客服按鈕」：
 *    2026-10-20 唯讀盤點 MYFEEL 90 個模組，58 個在結尾放了「真人客服」快速回覆（含 8/24 那顆訂單問題、
 *    每一個出貨進度查詢）。照「有那顆按鈕就不算自助」判，老闆舉的例子全部會被擋下來，等於沒修。
 *    那顆按鈕被客人按下去時才是轉真人的那一下，到時候走「真人客服」模組那條（不回模組）。
 *
 * 模組類型欄位（`moduleType`）後台已經不讓人選（2026-09-21），自建模組一律 bot_flow，所以這裡不讀它，
 * 只認系統給的「真人客服」那一個（同 handler.ts 的 isLiveAgentModule）。
 */
export function isSelfServiceModule(
  flow: { moduleType?: ModuleType | null; messages?: unknown } | null | undefined,
): boolean {
  if (!flow) return false
  if ((flow.moduleType ?? 'bot_flow') === 'live_agent') return false
  const messages = Array.isArray(flow.messages) ? flow.messages : []
  return !messages.some(m => (m as { type?: unknown } | null)?.type === 'userInput')
}
