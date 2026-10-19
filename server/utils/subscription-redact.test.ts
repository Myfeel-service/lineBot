/**
 * 訂閱回給瀏覽器前換掉扣款卡片代碼（`B-51`）。
 * 釘兩件事：真的代碼不出去；「有沒有綁卡」的判斷照舊成立（改方案確認框靠它）。
 */
import { describe, expect, it } from 'vitest'
import { CARD_TOKEN_REDACTED, redactSubscriptionForClient } from './subscription-redact'
import { describeSuperSubscriptionEdit } from '~~/shared/billing/subscription-edit'
import type { WorkspaceSubscription } from '~~/shared/billing/plans'

const sub = (extra: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription => ({
  planId: 'starter',
  status: 'active',
  autoRenew: true,
  currentPeriodStart: '2026-10-01',
  currentPeriodEnd: '2026-10-31',
  payuniCardToken: 'real-credit-hash',
  payuniCardLast4: '1234',
  ...extra,
} as WorkspaceSubscription)

describe('redactSubscriptionForClient', () => {
  it('🔴 真的卡片代碼換成記號、末四碼照留', () => {
    const out = redactSubscriptionForClient(sub())!
    expect(JSON.stringify(out)).not.toContain('real-credit-hash')
    expect(out.payuniCardToken).toBe(CARD_TOKEN_REDACTED)
    expect(out.payuniCardLast4).toBe('1234')
  })

  it('沒綁卡的不會憑空長出記號；沒有訂閱回 null', () => {
    expect(redactSubscriptionForClient(sub({ payuniCardToken: undefined }))!.payuniCardToken).toBeUndefined()
    expect(redactSubscriptionForClient(null)).toBeNull()
    expect(redactSubscriptionForClient(undefined)).toBeNull()
  })

  it('⛔ 不改到原物件（同一份可能是快取）', () => {
    const original = sub()
    redactSubscriptionForClient(original)
    expect(original.payuniCardToken).toBe('real-credit-hash')
  })

  it('換掉之後，改方案確認框講的話跟拿真代碼時一模一樣（判斷只看有沒有綁卡）', () => {
    const payload = { planId: 'growth', status: 'active' }
    const today = '2026-10-20'
    expect(describeSuperSubscriptionEdit(redactSubscriptionForClient(sub()), payload, today))
      .toEqual(describeSuperSubscriptionEdit(sub(), payload, today))
  })
})
