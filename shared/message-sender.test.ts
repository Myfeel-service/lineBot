import { describe, it, expect } from 'vitest'
import {
  MESSAGE_SENDERS,
  MESSAGE_SENDER_LABELS,
  MESSAGE_SENDER_HINTS,
  normalizeMessageSender,
  resolveMessageSender,
} from './message-sender'

describe('normalizeMessageSender', () => {
  it('accepts the four known senders', () => {
    for (const s of MESSAGE_SENDERS) {
      expect(normalizeMessageSender(s)).toBe(s)
    }
  })

  it('rejects anything else instead of guessing', () => {
    for (const bad of ['staff', 'robot', '', ' ', null, undefined, 0, {}]) {
      expect(normalizeMessageSender(bad)).toBeNull()
    }
  })
})

describe('resolveMessageSender', () => {
  it('客人傳的訊息不掛標籤', () => {
    expect(resolveMessageSender({ direction: 'incoming', sender: 'human' })).toBeNull()
  })

  it('有 sender 就照 sender', () => {
    expect(resolveMessageSender({ direction: 'outgoing', sender: 'bot' })).toBe('bot')
    expect(resolveMessageSender({ direction: 'outgoing', sender: 'system' })).toBe('system')
  })

  it('舊訊息（沒有 sender）一律回 null，不靠內容猜來源', () => {
    expect(resolveMessageSender({ direction: 'outgoing' })).toBeNull()
    expect(resolveMessageSender({ direction: 'outgoing', sender: '' })).toBeNull()
  })

  it('舊訊息只有 aiGenerated 這個真標記可以採信', () => {
    expect(resolveMessageSender({ direction: 'outgoing', aiGenerated: true })).toBe('ai')
    // 只有布林 true 算；'true' 這種字串是壞資料，不採信
    expect(resolveMessageSender({ direction: 'outgoing', aiGenerated: 'true' })).toBeNull()
    expect(resolveMessageSender({ direction: 'outgoing', aiGenerated: false })).toBeNull()
  })

  it('sender 優先於 aiGenerated：轉真人那句是模組文案，不能因為是 AI 決定的就標成 AI', () => {
    expect(resolveMessageSender({ direction: 'outgoing', sender: 'bot', aiGenerated: true })).toBe('bot')
  })

  it('每一種來源都有標籤字與說明（少一個就是 UI 出現空白標籤）', () => {
    for (const s of MESSAGE_SENDERS) {
      expect(MESSAGE_SENDER_LABELS[s]).toBeTruthy()
      expect(MESSAGE_SENDER_HINTS[s]).toBeTruthy()
    }
  })
})
