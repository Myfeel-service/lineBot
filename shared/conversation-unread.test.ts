import { describe, expect, it } from 'vitest'
import { customerLastMessageMs, isConversationUnread } from './conversation-unread'

/** 客人 09:00 傳的那句 */
const CUSTOMER_MS = 1_700_000_000_000
/** AI 三秒後回的那句（伺服器時間，比客人那則晚） */
const REPLY_MS = CUSTOMER_MS + 3_000

describe('紅點口徑：客人講過話就要看得到，直到有人真的看過', () => {
  it('AI 回過之後那一列還是要紅（舊口徑在這裡不亮，正是老闆回報的災情）', () => {
    const row = { customerLastMs: CUSTOMER_MS, lastMessageMs: REPLY_MS, lastDirection: 'outgoing' }
    expect(isConversationUnread(row, 0)).toBe(true)
  })

  it('有人看過（已讀時間晚於客人那則）就不紅', () => {
    const row = { customerLastMs: CUSTOMER_MS, lastMessageMs: REPLY_MS, lastDirection: 'outgoing' }
    expect(isConversationUnread(row, CUSTOMER_MS)).toBe(false)
    expect(isConversationUnread(row, REPLY_MS)).toBe(false)
  })

  it('看過之後客人又講一句 → 再紅一次', () => {
    const row = { customerLastMs: CUSTOMER_MS + 60_000, lastMessageMs: CUSTOMER_MS + 60_000, lastDirection: 'incoming' }
    expect(isConversationUnread(row, CUSTOMER_MS)).toBe(true)
  })

  it('客人從沒開口（只加好友／只按按鈕）不紅', () => {
    expect(isConversationUnread({ customerLastMs: 0, lastMessageMs: 0 }, 0)).toBe(false)
  })

  it('已結束的場：兩個時間都拿不到 → 不紅（後端刻意只給進行中那場）', () => {
    expect(isConversationUnread({ customerLastMs: 0, lastMessageMs: 0, lastDirection: 'incoming' }, 0)).toBe(false)
  })

  it('差 1 毫秒也算沒看過（比較是嚴格大於，不可以改成 >=）', () => {
    const row = { customerLastMs: CUSTOMER_MS, lastMessageMs: CUSTOMER_MS, lastDirection: 'incoming' }
    expect(isConversationUnread(row, CUSTOMER_MS - 1)).toBe(true)
    expect(isConversationUnread(row, CUSTOMER_MS)).toBe(false)
  })
})

describe('舊資料退路：2026-08-19 之前的對話沒有「客人最後一則」這個欄位', () => {
  it('沒有新欄位、最後一則是客人送的 → 照舊口徑亮', () => {
    const row = { customerLastMs: 0, lastMessageMs: CUSTOMER_MS, lastDirection: 'incoming' }
    expect(customerLastMessageMs(row)).toBe(CUSTOMER_MS)
    expect(isConversationUnread(row, 0)).toBe(true)
  })

  it('沒有新欄位、最後一則是我們回的 → 不亮（部署當下畫面不會無預警整排全紅）', () => {
    const row = { customerLastMs: 0, lastMessageMs: REPLY_MS, lastDirection: 'outgoing' }
    expect(customerLastMessageMs(row)).toBe(0)
    expect(isConversationUnread(row, 0)).toBe(false)
  })

  it('缺方向欄位的很舊資料當客人那側處理（寧可多亮一次，不要靜靜漏掉）', () => {
    const row = { customerLastMs: 0, lastMessageMs: CUSTOMER_MS }
    expect(isConversationUnread(row, 0)).toBe(true)
  })

  it('新欄位一旦有值就完全蓋過退路（不會被「最後一則是我們回的」擋掉）', () => {
    const row = { customerLastMs: CUSTOMER_MS, lastMessageMs: REPLY_MS, lastDirection: 'outgoing' }
    expect(customerLastMessageMs(row)).toBe(CUSTOMER_MS)
  })
})
