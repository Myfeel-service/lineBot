import type { AutoReplyAction } from './auto-reply-rule'
import {
  LINE_CARD_ALT_TEXT_URI,
  LINE_CARD_BODY_DEFAULT,
  LINE_CARD_BUTTON_LABEL_URI_DEFAULT,
} from './line-card-copy'
import { LINE_TEXT_MESSAGE_MAX, truncateLineText } from './line-text-limits'

/**
 * 「自動回應 / 客服預存 / 活動歡迎訊息」的動作 → 客人真的會收到的 LINE 訊息。
 *
 * **單一事實來源**（`C-230`）：這段邏輯原本只活在 `server/utils/handler.ts` 裡，
 * 所以後台那三頁**畫不出「客人會看到什麼」**——而它們送出去的東西跟推播一樣，
 * 不是店家打的字，是我們替他組的一張卡片。要讓預覽不說謊，唯一的辦法是
 * **預覽與送出讀同一支函式**（`H-27` 的教訓；推播那邊是 `broadcast-content.ts`）。
 *
 * ⚠️ `module` 回空陣列**不是「沒有訊息」**：選了模組時，客人收到的是**那個模組自己的**
 * 那幾則訊息，由呼叫端另外取（送出端走 `enterModule`，預覽端走 `/api/flow/{id}`）。
 * ⛔ 呼叫端不可以把空陣列畫成「這則是空的」——那正是空「歡迎模組」那場災情的形狀。
 */
export function autoReplyActionToLineMessages(
  action: Pick<AutoReplyAction, 'type' | 'text' | 'uri'>,
  options: { renderText?: (raw: string) => string } = {},
): Record<string, unknown>[] {
  const render = options.renderText ?? (s => s)

  if (action.type === 'message') {
    const text = render(action.text || '')
    /*
     * ⛔ 判空要看 `trim()`：只打了幾個空白時，原本會**真的送出一則看起來空白的訊息**給客人
     * （存檔驗證擋得住手打的空白，但變數代換後變成空字串這條路擋不到）。
     * ⛔ 但**送出去的內容不 trim**：多行文案的縮排是店家排版的一部分，不是雜訊。
     */
    if (!text.trim()) return []
    return [{ type: 'text', text: truncateLineText(text, LINE_TEXT_MESSAGE_MAX) }]
  }

  if (action.type === 'uri') {
    const uri = render(action.uri || '').trim()
    if (!uri) return []
    return [{
      type: 'template',
      altText: LINE_CARD_ALT_TEXT_URI,
      template: {
        type: 'buttons',
        text: LINE_CARD_BODY_DEFAULT,
        actions: [{ type: 'uri', label: LINE_CARD_BUTTON_LABEL_URI_DEFAULT, uri }],
      },
    }]
  }

  return []
}
