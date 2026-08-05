import { describe, expect, it } from 'vitest'
import { describeLineSendFailure } from './line-send-error'

/** 造一個和 @line/bot-sdk HTTPFetchError 同形狀的錯 */
function lineError(status: number, message: string) {
  return Object.assign(new Error('Request failed'), {
    status,
    body: JSON.stringify({ message }),
  })
}

describe('describeLineSendFailure', () => {
  it('客人封鎖／未加好友：講封鎖，不是含糊的「發送失敗」', () => {
    const reason = describeLineSendFailure(lineError(
      400,
      "The user hasn't added the LINE Official Account as a friend, or has blocked the LINE Official Account.",
    ))
    expect(reason).toContain('封鎖')
  })

  it('當月額度用完和送太快都是 429，但要講成不同的兩件事', () => {
    expect(describeLineSendFailure(lineError(429, 'You have reached your monthly limit.')))
      .toContain('本月推播則數已用完')
    expect(describeLineSendFailure(lineError(429, 'Too many requests')))
      .toContain('送太快')
  })

  it('超過 5000 字要直接告訴客服拆成兩則', () => {
    const reason = describeLineSendFailure(lineError(
      400,
      "The property, 'messages[0].text', length must be less than or equal to 5000",
    ))
    expect(reason).toContain('5000')
    expect(reason).toContain('拆成兩則')
  })

  it('憑證問題指向設定頁，不要讓客服以為是自己打的字有問題', () => {
    expect(describeLineSendFailure(lineError(401, 'Authentication failed'))).toContain('Channel access token')
    expect(describeLineSendFailure(lineError(403, 'Not authorized'))).toContain('Channel access token')
  })

  it('LINE 自己掛掉要說是對方的問題、可以再試', () => {
    expect(describeLineSendFailure(lineError(500, 'Internal server error'))).toContain('稍後再送')
  })

  it('沒歸類到的 400 至少把 LINE 原話附上，方便回報', () => {
    expect(describeLineSendFailure(lineError(400, 'Invalid message type')))
      .toContain('Invalid message type')
  })

  it('不是 LINE 退件就回 null，呼叫端才知道要原封不動往上丟', () => {
    expect(describeLineSendFailure(new Error('boom'))).toBeNull()
    expect(describeLineSendFailure({ statusCode: 404, statusMessage: '找不到此使用者' })).toBeNull()
    expect(describeLineSendFailure(null)).toBeNull()
    // status 有但 body 不是字串 → 不是 SDK 那個錯，別亂認
    expect(describeLineSendFailure({ status: 400, body: { message: 'x' } })).toBeNull()
  })
})
