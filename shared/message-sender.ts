/**
 * 一則「對客人送出」的訊息是誰回的。
 *
 * 客服打開一場對話最先想知道的就是這件事：同事回過了嗎、還是 AI 自己答的、還是機器人
 * 模組跳出來的？先前訊息流完全看不出來，實際造成三件事：文案講錯了不知道要去改哪裡、
 * AI 答錯看起來像同事講的、同事又重複回一次 AI 已經答過的問題。
 *
 * 只標 outgoing——客人自己傳的不需要標。
 *
 * 四種刻意不併成三種：「系統」那幾句內建安撫語（等待中 ack、勿擾時段回覆）後台**沒有**
 * 對應的機器人模組可以改，標成「機器人」會讓客服去翻一個不存在的模組。
 */
export type MessageSender = 'human' | 'ai' | 'bot' | 'system'

export const MESSAGE_SENDERS = ['human', 'ai', 'bot', 'system'] as const

/** 泡泡上那顆標籤的字。短到不會把 meta 撐開換行，長話留給 tooltip。 */
export const MESSAGE_SENDER_LABELS: Record<MessageSender, string> = {
  human: '真人',
  ai: 'AI',
  bot: '機器人',
  system: '系統',
}

/** tooltip：白話講清楚這句話哪裡來的、要改的話去哪改 */
export const MESSAGE_SENDER_HINTS: Record<MessageSender, string> = {
  human: '客服人員手動回覆的。',
  ai: 'AI 客服自動回覆的，內容是 AI 依知識庫當場生成，不是固定文案。',
  bot: '機器人模組／自動回覆規則送出的固定內容，要改文案去該模組或規則改。',
  system: '系統內建的自動訊息（例如「已收到您的訊息」、勿擾時段回覆）。後台沒有對應的模組可改。',
}

export function normalizeMessageSender(raw: unknown): MessageSender | null {
  const value = String(raw ?? '').trim()
  return (MESSAGE_SENDERS as readonly string[]).includes(value)
    ? value as MessageSender
    : null
}

/**
 * 讀取時決定這則泡泡要掛哪一顆標籤。
 *
 * 這個功能上線前存的舊訊息沒有 sender 欄位 → 回 null＝**不顯示標籤**。
 * 刻意不拿訊息型別／內容去猜：猜錯比空白更糟，客服會拿一個假的來源去追責任。
 * 唯一例外是 `aiGenerated`，那是 AI 答題／反問當下就蓋好的真標記，可以直接採信。
 */
export function resolveMessageSender(input: {
  direction?: string | null
  sender?: unknown
  aiGenerated?: unknown
}): MessageSender | null {
  if (input.direction !== 'outgoing') return null
  return normalizeMessageSender(input.sender)
    ?? (input.aiGenerated === true ? 'ai' : null)
}
