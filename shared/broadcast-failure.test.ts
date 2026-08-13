import { describe, expect, it } from 'vitest'
import { humanizeBroadcastSendFailure } from './broadcast-failure'

/**
 * 失敗原因是給操作的人看的（小幫手警示已承諾「進去看失敗原因，處理後可以重新發送」），
 * 所以①認得的錯誤要講人話②認不得的也要有話講，還要留原文給工程查。
 */
describe('humanizeBroadcastSendFailure', () => {
  it('受眾 0 人 → 講清楚是發送對象的問題，且沒有送出任何訊息', () => {
    const out = humanizeBroadcastSendFailure('Resolved audience is empty')
    expect(out).toContain('0 人')
    expect(out).toContain('沒有送出任何訊息')
  })

  it('模組被刪 → 指向要重選模組', () => {
    const out = humanizeBroadcastSendFailure('Broadcast module not found or empty: mod123')
    expect(out).toContain('模組')
    expect(out).toContain('沒有送出任何訊息')
  })

  it('沒有訊息內容 → 指向補內容', () => {
    expect(humanizeBroadcastSendFailure('No messages to send')).toContain('沒有訊息內容')
  })

  it('認不出來的錯誤 → 仍要有人話，並保留原文當線索', () => {
    const out = humanizeBroadcastSendFailure('ECONNRESET socket hang up')
    expect(out).toContain('還沒送出任何訊息')
    expect(out).toContain('ECONNRESET socket hang up')
  })

  it('空字串也不能吐出空白說明', () => {
    expect(humanizeBroadcastSendFailure('')).toContain('未知錯誤')
  })
})
