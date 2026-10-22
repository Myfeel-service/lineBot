/**
 * customerReturnedAtMs：客人回來在等的時間，只有晚於真人最後一次回覆才算數（`C-381`）。
 */
import { describe, expect, it } from 'vitest'
import { customerReturnedAtMs } from './conversation-stats'

const ts = (ms: number) => ({ toMillis: () => ms })

describe('customerReturnedAtMs', () => {
  it('客人回來之後還沒人回 → 回來的時間', () => {
    expect(customerReturnedAtMs({ customerReturnedAt: ts(2000), humanLastRepliedAt: ts(1000) })).toBe(2000)
  })

  it('客服回過話了（晚於回來的時間）→ 0，舊值只是歷史', () => {
    expect(customerReturnedAtMs({ customerReturnedAt: ts(2000), humanLastRepliedAt: ts(3000) })).toBe(0)
  })

  it('沒有 humanLastRepliedAt 的舊資料退回看首接時間', () => {
    expect(customerReturnedAtMs({ customerReturnedAt: ts(2000), humanFirstRepliedAt: ts(3000) })).toBe(0)
    expect(customerReturnedAtMs({ customerReturnedAt: ts(2000), humanFirstRepliedAt: ts(1000) })).toBe(2000)
  })

  it('序列化過的時間（{_seconds}）也讀得懂', () => {
    expect(customerReturnedAtMs({ customerReturnedAt: { _seconds: 20 }, humanLastRepliedAt: { _seconds: 10 } })).toBe(20_000)
  })

  it('沒有回來的時間 → 0', () => {
    expect(customerReturnedAtMs({ humanLastRepliedAt: ts(1000) })).toBe(0)
    expect(customerReturnedAtMs(undefined)).toBe(0)
  })
})
