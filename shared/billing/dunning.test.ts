import { describe, expect, it } from 'vitest'
import { buildDunningRow, graceDeadline, isNonPaymentDowngrade, monthDayText, plainChargeError, sortDunningRows, type DunningRow } from './dunning'
import { rollSubscriptionToCurrentPeriod } from './period'
import type { WorkspaceSubscription } from './plans'

/** 扣款失敗那一期（10/20 起）：已被 roll 推進新一期、等扣款 */
function pastDue(over: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription {
  return {
    planId: 'lite',
    status: 'past_due',
    currentPeriodStart: '2026-10-20',
    currentPeriodEnd: '2026-11-19',
    anchorDay: 20,
    autoRenew: true,
    payuniCardToken: 'HASH1',
    payuniCardLast4: '1234',
    chargePeriodStart: '2026-10-20',
    chargeAttempts: 1,
    lastChargeDate: '2026-10-20',
    lastChargeError: '授權失敗',
    ...over,
  }
}

describe('graceDeadline（`B-16`：信、帳單頁、實際降級講同一天）', () => {
  it('10/20 那期扣失敗 → 10/23 是最後一天、10/24 起降回免費', () => {
    expect(graceDeadline('2026-10-20')).toEqual({ lastDay: '2026-10-23', downgradeOn: '2026-10-24' })
  })

  it('🔴 跟真正的降級規則（period.ts 的 roll）對得上：最後一天還沒降、隔天就降', () => {
    const { lastDay, downgradeOn } = graceDeadline('2026-10-20')
    expect(rollSubscriptionToCurrentPeriod(pastDue(), lastDay).downgraded).toBe(false)
    expect(rollSubscriptionToCurrentPeriod(pastDue(), downgradeOn).downgraded).toBe(true)
  })

  it('跨月也對', () => {
    expect(graceDeadline('2026-10-30')).toEqual({ lastDay: '2026-11-02', downgradeOn: '2026-11-03' })
  })
})

describe('plainChargeError（帳單頁與店家提醒同一份白話對照）', () => {
  it('授權失敗 → 卡片沒通過（不帶括號：LINE 推播會整句包進括號）；其他原樣；空的回空字串', () => {
    expect(plainChargeError('授權失敗')).toBe('卡片沒通過，銀行沒有核准這筆交易')
    expect(plainChargeError('卡片已過期')).toBe('卡片已過期')
    expect(plainChargeError(null)).toBe('')
  })
})

describe('monthDayText', () => {
  it('講成「10 月 23 日」，不帶年份、不補零', () => {
    expect(monthDayText('2026-10-23')).toBe('10 月 23 日')
    expect(monthDayText('2026-01-05')).toBe('1 月 5 日')
  })
})

describe('isNonPaymentDowngrade（只有「卡一直扣不到」才寄「已降回免費」）', () => {
  it('🔴 自動續訂、有卡、寬限期滿 → 是', () => {
    const before = pastDue()
    expect(isNonPaymentDowngrade(before, rollSubscriptionToCurrentPeriod(before, '2026-10-24'))).toBe(true)
  })

  it('還在寬限期（沒降級）→ 不是', () => {
    const before = pastDue()
    expect(isNonPaymentDowngrade(before, rollSubscriptionToCurrentPeriod(before, '2026-10-23'))).toBe(false)
  })

  it('客戶自己按了取消、到期降回免費 → 不是（那是他要的）', () => {
    const before: WorkspaceSubscription = { ...pastDue(), status: 'active', currentPeriodStart: '2026-09-20', currentPeriodEnd: '2026-10-19', cancelAtPeriodEnd: true }
    const rolled = rollSubscriptionToCurrentPeriod(before, '2026-10-20')
    expect(rolled.downgraded).toBe(true)
    expect(isNonPaymentDowngrade(before, rolled)).toBe(false)
  })

  it('沒綁卡、到期直接降 → 不是（那條已有綁卡提醒信）', () => {
    const before: WorkspaceSubscription = { ...pastDue(), status: 'active', currentPeriodStart: '2026-09-20', currentPeriodEnd: '2026-10-19', payuniCardToken: undefined }
    const rolled = rollSubscriptionToCurrentPeriod(before, '2026-10-20')
    expect(rolled.downgraded).toBe(true)
    expect(isNonPaymentDowngrade(before, rolled)).toBe(false)
  })

  it('排程好幾天沒跑、自動續訂的帳號直接被推過寬限期 → 也是（一樣是錢沒收到）', () => {
    const before: WorkspaceSubscription = { ...pastDue(), status: 'active', currentPeriodStart: '2026-09-20', currentPeriodEnd: '2026-10-19' }
    expect(isNonPaymentDowngrade(before, rollSubscriptionToCurrentPeriod(before, '2026-10-30'))).toBe(true)
  })
})

describe('buildDunningRow（超管扣款失敗清單的一列，`B-43`②）', () => {
  it('還在寬限期：原因、第幾次、哪天前沒扣到就降、卡號末四碼', () => {
    expect(buildDunningRow('ws1', 'MYFEEL', pastDue({ chargeFailedEmailSentFor: '2026-10-20' }), '2026-10-21')).toEqual({
      workspaceId: 'ws1',
      workspaceName: 'MYFEEL',
      state: 'past_due',
      planId: 'lite',
      planName: '輕量',
      lastChargeError: '授權失敗',
      attempts: 1,
      lastChargeDate: '2026-10-20',
      graceLastDay: '2026-10-23',
      downgradeOn: '2026-10-24',
      cardLast4: '1234',
      email: 'sent',
    } satisfies DunningRow)
  })

  it('🔴 扣款失敗信還沒寄成功 → 標「還沒寄出」（不能看起來像已通知客戶）', () => {
    expect(buildDunningRow('ws1', 'A', pastDue(), '2026-10-21')?.email).toBe('pending')
  })

  it('沒有帳務信箱可寄 → 分得出來，不是「已寄信」', () => {
    const sub = pastDue({ chargeFailedEmailSentFor: '2026-10-20', chargeFailedEmailNoRecipientFor: '2026-10-20' })
    expect(buildDunningRow('ws1', 'A', sub, '2026-10-21')?.email).toBe('no_recipient')
  })

  it('這期還沒扣過（排程還沒輪到）→ 第 0 次、沒有原因、不適用失敗信；上一期留下的次數不算', () => {
    const row = buildDunningRow('ws1', 'A', pastDue({ chargePeriodStart: '2026-09-20', chargeAttempts: 3, lastChargeError: null }), '2026-10-20')
    expect(row).toMatchObject({ state: 'past_due', attempts: 0, lastChargeError: null, email: null })
  })

  it('寬限期剛過、對帳還沒寫回去 → 照實講「已降」', () => {
    expect(buildDunningRow('ws1', 'A', pastDue(), '2026-10-24')).toMatchObject({ state: 'downgraded', graceLastDay: null, downgradeOn: '2026-10-24' })
  })

  it('近 14 天因扣不到款降回免費 → 列出降級前方案、降級日、「已降回免費」信寄了沒', () => {
    const sub: WorkspaceSubscription = {
      ...pastDue({ status: 'active', planId: 'free', autoRenew: false }),
      nonPaymentDowngrade: { fromPlanId: 'starter', on: '2026-10-24', emailSent: false },
    }
    expect(buildDunningRow('ws1', 'A', sub, '2026-10-30')).toMatchObject({
      state: 'downgraded', planId: 'starter', downgradeOn: '2026-10-24', email: 'pending', lastChargeError: '授權失敗',
    })
  })

  it('降級超過 14 天、或之後又付費了 → 不列', () => {
    const base: WorkspaceSubscription = {
      ...pastDue({ status: 'active', planId: 'free', autoRenew: false }),
      nonPaymentDowngrade: { fromPlanId: 'lite', on: '2026-10-01', emailSent: true },
    }
    expect(buildDunningRow('ws1', 'A', base, '2026-10-30')).toBeNull()
    expect(buildDunningRow('ws1', 'A', { ...base, planId: 'lite', nonPaymentDowngrade: { fromPlanId: 'lite', on: '2026-10-29', emailSent: true } }, '2026-10-30')).toBeNull()
  })

  it('正常付費中、免費、企業方案的 past_due → 不列', () => {
    expect(buildDunningRow('ws1', 'A', { ...pastDue(), status: 'active' }, '2026-10-21')).toBeNull()
    expect(buildDunningRow('ws1', 'A', { ...pastDue(), planId: 'enterprise' }, '2026-10-21')).toBeNull()
    expect(buildDunningRow('ws1', 'A', null, '2026-10-21')).toBeNull()
  })
})

describe('sortDunningRows', () => {
  it('還在寬限期的在前、最快到期的最前面；已降級的在後、最近的在前', () => {
    const r = (id: string, state: DunningRow['state'], graceLastDay: string | null, downgradeOn: string) =>
      ({ workspaceId: id, state, graceLastDay, downgradeOn }) as DunningRow
    const sorted = sortDunningRows([
      r('d-old', 'downgraded', null, '2026-10-10'),
      r('p-late', 'past_due', '2026-10-25', '2026-10-26'),
      r('d-new', 'downgraded', null, '2026-10-18'),
      r('p-soon', 'past_due', '2026-10-21', '2026-10-22'),
    ])
    expect(sorted.map(x => x.workspaceId)).toEqual(['p-soon', 'p-late', 'd-new', 'd-old'])
  })
})
