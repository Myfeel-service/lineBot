/**
 * 對話裡「店家這一側」的一句話是誰講的——訊息上的 `sender`（見對話「誰回的」標籤）。
 *
 * 目前只有轉真人摘要用（`C-344`）：AI 自動回覆講的出貨日沒查過訂單、也可能講錯，
 * 摘要要分得出「AI 說過」和「真人告知過」。2026-10-12 摘要把 AI 講錯的「第二批 11 月底」
 * 寫成「目前得知訂單為第二批」，隔天真人照著回了客人。
 */
export type ChatSpeaker = 'ai' | 'human' | 'bot' | 'system'

/** 訊息上的 sender 轉成 ChatSpeaker；認不得（舊資料沒有 sender）回 undefined */
export function chatSpeakerOf(sender: unknown): ChatSpeaker | undefined {
  return sender === 'ai' || sender === 'human' || sender === 'bot' || sender === 'system' ? sender : undefined
}
