/**
 * 模組「＋文字」掛了按鈕時，送給客人的那張卡（`C-397`，`D-153`）。
 *
 * 以前這種訊息走 LINE 的「按鈕範本」，那個格式文字只收 160 字——超過的被切掉、客人收到半截
 * （`H-27`），而這個限制從來不是誰選的：2026-04 第一版照現成版型做，後來加了卡片格式也沒回頭換。
 * 卡片格式（Flex）的文字本身沒有字數上限，只限整張 30 KB。
 *
 * 2026-10-28 拿 LINE 的驗證端點實測（不送出）：5000 中文字＋4 顆最長（1000 字）網址按鈕＝19.3 KB 收、
 * 8000 字 28.1 KB 收、12000 字 39.9 KB 退（LINE 量的是 UTF-8 位元組）。所以文字上限跟純文字一樣
 * 5000（`LINE_TEXT_MESSAGE_MAX`），有沒有按鈕都一樣。
 *
 * ⛔ 組卡片跟認卡片放在同一支：對話頁要把它畫回「文字＋按鈕」（`AdminPanel.vue`）。兩邊各寫一份形狀的話，
 *    哪天組法改了、認法沒跟上，對話頁會退回通用卡片畫法——整段文字當標題、提醒文字再重複一次。
 * ⚠️ 樣子刻意貼近原本的按鈕範本（白卡、文字、底下一排藍字按鈕），客人看起來跟以前差不多，差在字不會被切。
 *    要做大圖／實心按鈕那種卡是 `D-153` ⑵，不在這裡。
 */

type LineAction = Record<string, unknown>

export function buildTextButtonsCard(input: {
  text: string
  altText: string
  actions: LineAction[]
}): Record<string, unknown> {
  const bubble: Record<string, unknown> = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [{ type: 'text', text: input.text, wrap: true }],
    },
  }
  // ⚠️ LINE 不收空的 box：沒有按鈕就不放 footer（呼叫端本來只在有按鈕時才走這裡，這裡再保險一次）
  if (input.actions.length) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      contents: input.actions.map(action => ({ type: 'button', style: 'link', height: 'sm', action })),
    }
    bubble.styles = { footer: { separator: true } }
  }
  return { type: 'flex', altText: input.altText, contents: bubble }
}

/**
 * 這則 LINE 訊息是不是上面那支組出來的卡；是的話拿回文字與按鈕動作，不是回 null。
 * 認法要嚴：只有一段文字、底下全是按鈕、沒有大圖也沒有標題列——
 * 圖文訊息走 Flex 的單張卡（body 裡是圖）、輪播的卡（有 hero）都不可以被認成這種。
 */
export function parseTextButtonsCard(message: unknown): { text: string, actions: LineAction[] } | null {
  const m = message as { type?: unknown, contents?: Record<string, any> } | null
  if (!m || m.type !== 'flex') return null
  const bubble = m.contents
  if (!bubble || bubble.type !== 'bubble' || bubble.hero || bubble.header) return null
  const bodyContents = bubble.body?.contents
  if (!Array.isArray(bodyContents) || bodyContents.length !== 1) return null
  const only = bodyContents[0]
  if (only?.type !== 'text' || typeof only.text !== 'string') return null
  const footerContents = bubble.footer?.contents ?? []
  if (!Array.isArray(footerContents) || !footerContents.every((c: any) => c?.type === 'button' && c.action)) return null
  return { text: only.text, actions: footerContents.map((c: any) => c.action as LineAction) }
}
