import { describe, expect, it } from 'vitest'
import { isSelfServiceModule } from './self-service-module'

describe('isSelfServiceModule（等真人期間按到要不要照樣回，`D-31`）', () => {
  it('一般自建模組（查訂單、商品目錄）→ 自助，照樣回', () => {
    expect(isSelfServiceModule({ moduleType: 'bot_flow', messages: [{ type: 'text', text: '商品目錄' }] })).toBe(true)
  })

  it('⛔ 模組裡有一顆「真人客服」按鈕 → 照樣算自助（按那顆按鈕才是轉真人的那一下）', () => {
    // MYFEEL 90 個模組有 58 個結尾放了這顆；照「有就不算」判，查訂單、出貨進度全都會被擋
    expect(isSelfServiceModule({
      moduleType: 'bot_flow',
      messages: [{ type: 'quickReply', text: '請選擇', quickReplies: [{ action: { type: 'module', label: '真人客服', moduleId: 'ws_live_agent' } }] }],
    })).toBe(true)
  })

  it('「真人客服」模組本身 → 不是自助（按下去就是要找人）', () => {
    expect(isSelfServiceModule({ moduleType: 'live_agent', messages: [{ type: 'text', text: '客服會很快聯絡您' }] })).toBe(false)
  })

  it('要客人接著打字回答的模組 → 不是自助（等真人期間機器人不接他的答案）', () => {
    expect(isSelfServiceModule({
      moduleType: 'bot_flow',
      messages: [{ type: 'text', text: '請輸入備註' }, { type: 'userInput', moduleId: 'next', attribute: 'note' }],
    })).toBe(false)
  })

  it('找不到／停用的模組 → 不是自助（沒有東西可以回）', () => {
    expect(isSelfServiceModule(null)).toBe(false)
    expect(isSelfServiceModule(undefined)).toBe(false)
  })

  it('舊資料沒有 moduleType、messages 壞掉 → 照自建模組處理，不炸', () => {
    expect(isSelfServiceModule({ messages: [{ type: 'text', text: 'hi' }] })).toBe(true)
    expect(isSelfServiceModule({ moduleType: null, messages: 'oops' })).toBe(true)
  })
})
