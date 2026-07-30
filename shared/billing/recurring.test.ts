import { describe, expect, it } from 'vitest'
import { isDowngrade, planRank, resolveNextPeriodPlanId, resolveRecurringCharge } from './recurring'
import type { WorkspaceSubscription } from './plans'

const sub = (over: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription => ({
  planId: 'starter', // 799
  status: 'past_due',
  currentPeriodStart: '2026-08-28',
  currentPeriodEnd: '2026-09-27',
  ...over,
})

describe('resolveNextPeriodPlanId（降級期末生效）', () => {
  it('沒排程 → 沿用現行方案', () => {
    expect(resolveNextPeriodPlanId(sub())).toBe('starter')
    expect(resolveNextPeriodPlanId(sub({ pendingPlanId: null }))).toBe('starter')
  })
  it('有排程 → 下期用排程的方案', () => {
    expect(resolveNextPeriodPlanId(sub({ pendingPlanId: 'lite' }))).toBe('lite')
  })
  it('排程等於現行方案 → 視為沒排程（不讓它變成無意義的狀態）', () => {
    expect(resolveNextPeriodPlanId(sub({ pendingPlanId: 'starter' }))).toBe('starter')
  })
  it('排程指向不存在的方案 → 沿用現行（壞資料不能把方案卡住或降成 free）', () => {
    expect(resolveNextPeriodPlanId(sub({ pendingPlanId: 'nope' as never }))).toBe('starter')
  })
})

describe('isDowngrade / planRank', () => {
  it('依方案順序判斷升降級', () => {
    expect(isDowngrade('growth', 'lite')).toBe(true)
    expect(isDowngrade('lite', 'growth')).toBe(false)
    expect(isDowngrade('lite', 'lite')).toBe(false)
    expect(isDowngrade('lite', 'free')).toBe(true)
    expect(planRank('free')).toBeLessThan(planRank('lite'))
  })
})

describe('resolveRecurringCharge（下期扣多少）', () => {
  it('沒折抵 → 就是方案月費', () => {
    const r = resolveRecurringCharge(sub())
    expect(r).toMatchObject({ planId: 'starter', price: 799, amount: 799, creditUsed: 0, creditRemaining: 0, fullyCovered: false })
  })

  it('折抵少於月費 → 這期少扣一點，餘額歸零', () => {
    const r = resolveRecurringCharge(sub({ creditBalance: 300 }))
    expect(r).toMatchObject({ amount: 499, creditUsed: 300, creditRemaining: 0, fullyCovered: false })
  })

  it('折抵大於月費 → 只折到月費，剩下的留到下期（可累積、逐期折到用完）', () => {
    const r = resolveRecurringCharge(sub({ creditBalance: 2000 }))
    expect(r).toMatchObject({ amount: 0, creditUsed: 799, creditRemaining: 1201, fullyCovered: true })
  })

  it('折抵剛好等於月費 → 這期不用扣款（fullyCovered）', () => {
    const r = resolveRecurringCharge(sub({ creditBalance: 799 }))
    expect(r).toMatchObject({ amount: 0, creditUsed: 799, creditRemaining: 0, fullyCovered: true })
  })

  it('降級排程 + 折抵 → 用**新方案**的價格算折抵（不是舊方案）', () => {
    // starter 799 → 排程降 lite 399；折抵 500 → 只能折到 399，剩 101 留下期
    const r = resolveRecurringCharge(sub({ pendingPlanId: 'lite', creditBalance: 500 }))
    expect(r).toMatchObject({ planId: 'lite', price: 399, amount: 0, creditUsed: 399, creditRemaining: 101, fullyCovered: true })
  })

  it('排程降到免費層 → 沒有月費可扣，折抵原封不動留著', () => {
    const r = resolveRecurringCharge(sub({ pendingPlanId: 'free', creditBalance: 500 }))
    expect(r).toMatchObject({ planId: 'free', price: 0, amount: 0, creditUsed: 0, creditRemaining: 500, fullyCovered: false })
  })

  it('客製方案（無定價）→ 不算扣款金額，折抵不動', () => {
    const r = resolveRecurringCharge(sub({ planId: 'enterprise', creditBalance: 500 }))
    expect(r).toMatchObject({ price: null, amount: 0, creditUsed: 0, creditRemaining: 500 })
  })

  it('壞資料防呆：負數 / 小數折抵不會變成加價或小數請款', () => {
    expect(resolveRecurringCharge(sub({ creditBalance: -100 }))).toMatchObject({ amount: 799, creditUsed: 0 })
    expect(resolveRecurringCharge(sub({ creditBalance: 100.7 }))).toMatchObject({ amount: 699, creditUsed: 100 })
  })
})
