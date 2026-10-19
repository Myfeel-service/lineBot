import { describe, expect, it } from 'vitest'
import { emailHealthState, type EmailHealthInput } from './email-health'

/** `B-50`：寄信設定壞了以前沒有任何地方看得到 */
function h(over: Partial<EmailHealthInput> = {}): EmailHealthInput {
  return {
    configured: true, from: 'noreply@lineminime.com', region: 'ap-northeast-1', paymentEnabled: true,
    lastSuccessAt: 1000, lastSuccessSubject: 's', lastFailureAt: null, lastFailureSubject: null, lastFailureError: null,
    ...over,
  }
}

describe('emailHealthState', () => {
  it('最近一次寄成功 → ok', () => {
    expect(emailHealthState(h())).toBe('ok')
  })

  it('🔴 成功之後又寄失敗 → broken（權限掉了、網域失效都長這樣）', () => {
    expect(emailHealthState(h({ lastFailureAt: 2000 }))).toBe('broken')
    expect(emailHealthState(h({ lastSuccessAt: null, lastFailureAt: 2000 }))).toBe('broken')
  })

  it('失敗之後又寄成功（重試寄出去了）→ ok', () => {
    expect(emailHealthState(h({ lastFailureAt: 500 }))).toBe('ok')
  })

  it('🔴 付款開著、寄信卻沒設定 → broken（每封帳務信都寄不出去）', () => {
    expect(emailHealthState(h({ configured: false, from: '', region: '' }))).toBe('broken')
  })

  it('付款沒開也沒設定（本機／還沒上線）→ off，不亮點', () => {
    expect(emailHealthState(h({ configured: false, paymentEnabled: false }))).toBe('off')
  })

  it('設定齊了、從沒寄過 → unsent（不知道通不通）', () => {
    expect(emailHealthState(h({ lastSuccessAt: null }))).toBe('unsent')
  })
})
