import { describe, expect, it } from 'vitest'
import { applySuperSubscriptionEdit, SubscriptionEditError } from './subscription-edit'
import type { WorkspaceSubscription } from './plans'

// 一份「綁了卡、有折抵、有預約降級」的訂閱——正是 B-37 事故裡會被清掉的那種
function liveSubscription(): WorkspaceSubscription {
  return {
    planId: 'starter',
    status: 'active',
    currentPeriodStart: '2026-08-05',
    currentPeriodEnd: '2026-09-04',
    anchorDay: 5,
    payuniCardToken: 'hash-secret',
    payuniCardLast4: '1234',
    payuniCardExpiry: '0328',
    autoRenew: true,
    cancelAtPeriodEnd: false,
    pendingPlanId: 'lite',
    creditBalance: 250,
    lastChargeDate: '2026-08-05',
    chargeAttempts: 1,
    chargePeriodStart: '2026-08-05',
    lastChargeError: null,
    quotaOverride: 3000,
    note: '業務談定',
  }
}

describe('applySuperSubscriptionEdit', () => {
  it('B-37 回歸：只改備註不會清掉綁卡／折抵／續扣狀態', () => {
    const existing = liveSubscription()
    const merged = applySuperSubscriptionEdit(existing, {
      planId: 'starter',
      status: 'active',
      currentPeriodStart: '2026-08-05',
      currentPeriodEnd: '2026-09-04',
      anchorDay: 5,
      quotaOverride: 3000,
      note: '改個備註而已',
    })
    expect(merged.note).toBe('改個備註而已')
    // 計費憑證與狀態一根毛都不能少
    expect(merged.payuniCardToken).toBe('hash-secret')
    expect(merged.payuniCardLast4).toBe('1234')
    expect(merged.autoRenew).toBe(true)
    expect(merged.creditBalance).toBe(250)
    expect(merged.pendingPlanId).toBe('lite')
    expect(merged.lastChargeDate).toBe('2026-08-05')
    expect(merged.chargeAttempts).toBe(1)
  })

  it('改方案／狀態只動那兩個欄位，其餘保留', () => {
    const merged = applySuperSubscriptionEdit(liveSubscription(), {
      planId: 'growth',
      status: 'past_due',
      currentPeriodStart: '2026-08-05',
      currentPeriodEnd: '2026-09-04',
      anchorDay: 5,
    })
    expect(merged.planId).toBe('growth')
    expect(merged.status).toBe('past_due')
    expect(merged.payuniCardToken).toBe('hash-secret')
    expect(merged.creditBalance).toBe(250)
  })

  it('清空 quotaOverride／note 會真的移除，不會殘留舊值', () => {
    const merged = applySuperSubscriptionEdit(liveSubscription(), {
      planId: 'starter',
      currentPeriodStart: '2026-08-05',
      quotaOverride: null,
      note: '',
    })
    expect('quotaOverride' in merged).toBe(false)
    expect('note' in merged).toBe(false)
  })

  it('沒有既有訂閱＝建新的：週期由錨定日推出', () => {
    const merged = applySuperSubscriptionEdit(undefined, {
      planId: 'lite',
      currentPeriodStart: '2026-08-16',
    })
    expect(merged.planId).toBe('lite')
    expect(merged.status).toBe('active')
    expect(merged.currentPeriodStart).toBe('2026-08-16')
    expect(merged.currentPeriodEnd).toBe('2026-09-15')
    expect(merged.anchorDay).toBe(16)
    expect(merged.payuniCardToken).toBeUndefined()
  })

  it('明確指定到期日（合約特例）時尊重之', () => {
    const merged = applySuperSubscriptionEdit(undefined, {
      planId: 'lite',
      currentPeriodStart: '2026-08-16',
      currentPeriodEnd: '2026-12-31',
    })
    expect(merged.currentPeriodEnd).toBe('2026-12-31')
  })

  it('planId／status 不合法要擋（給 API 層轉 400）', () => {
    expect(() => applySuperSubscriptionEdit(undefined, { planId: 'nope' }))
      .toThrow(SubscriptionEditError)
    expect(() => applySuperSubscriptionEdit(undefined, { planId: 'lite', status: 'weird' }))
      .toThrow(SubscriptionEditError)
  })
})
