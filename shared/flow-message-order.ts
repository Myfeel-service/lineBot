/**
 * 機器人模組裡「快速回覆」一定要是最後一則（`C-424`）。
 *
 * LINE 一次收到好幾則時，只顯示**最後一則**上的快速回覆按鈕（Messaging API 參考：
 * 「If the user receives multiple message objects, the quickReply property of the last message object is displayed」）。
 * 排在中間照樣送得出去、文字也到了，只有按鈕默默不見——店家不會知道。
 * 2026-10-29 盤點正式庫 58 則快速回覆都剛好在最後，這條擋的是之後拖錯的。
 *
 * 前端 `flow.vue` 的存檔檢查跟後端 `server/utils/flow-validator.ts` 用同一句。
 */
export const QUICK_REPLY_NOT_LAST_MESSAGE = '快速回覆要放在最後一則：LINE 只會在最後一則訊息下面顯示快速回覆的按鈕'

export function quickReplyNotLastError(messages: readonly any[]): string | null {
  const idx = messages.findIndex(m => m?.type === 'quickReply')
  if (idx === -1 || idx === messages.length - 1) return null
  return QUICK_REPLY_NOT_LAST_MESSAGE
}
