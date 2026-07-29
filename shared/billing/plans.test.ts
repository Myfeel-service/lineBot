import { describe, expect, it } from 'vitest'
import type { BillingPlanId } from './plans'
import {
  BILLING_PLANS,
  BILLING_PLAN_ORDER,
  DEFAULT_BILLING_PLAN_ID,
  OVERAGE_PER_REPLY_TWD,
  effectiveAnsweredQuota,
  getBillingPlan,
} from './plans'

describe('BILLING_PLANS catalog', () => {
  it('每個 key 與其 id 相符', () => {
    for (const [key, plan] of Object.entries(BILLING_PLANS)) {
      expect(plan.id).toBe(key)
    }
  })

  it('BILLING_PLAN_ORDER 剛好涵蓋所有方案、無漏無重', () => {
    expect([...BILLING_PLAN_ORDER].sort()).toEqual(Object.keys(BILLING_PLANS).sort())
    expect(new Set(BILLING_PLAN_ORDER).size).toBe(BILLING_PLAN_ORDER.length)
  })

  it('則數與月費隨等級單調遞增（企業為客製 null 除外）', () => {
    const paid = BILLING_PLAN_ORDER.map(id => BILLING_PLANS[id]).filter(p => p.answeredQuota != null)
    for (let i = 1; i < paid.length; i++) {
      const cur = paid[i]!
      const prev = paid[i - 1]!
      expect(cur.answeredQuota!).toBeGreaterThan(prev.answeredQuota!)
      expect(cur.priceMonthly!).toBeGreaterThan(prev.priceMonthly!)
    }
  })

  it('免費層不開放超量、企業走客製；其餘付費方案共用統一超量單價', () => {
    expect(BILLING_PLANS.free.overagePerReply).toBeNull()
    expect(BILLING_PLANS.enterprise.overagePerReply).toBeNull()
    for (const id of ['lite', 'starter', 'growth', 'pro'] as BillingPlanId[]) {
      expect(BILLING_PLANS[id].overagePerReply).toBe(OVERAGE_PER_REPLY_TWD)
    }
  })

  it('官網門面露出的付費價格 = 已向金流申報的售價階段', () => {
    // PAYUNi 特店申報的售價階段是 399 / 799 / 1499。信用卡收單的風控會拿官網顯示的價格
    // 與申報資料互相核對——門面多一個或少一個價格都可能被退件（見 plans.ts 的 landingHidden）。
    // 改價或改 landingHidden 時，這個測試會先擋下來，提醒你同步更新送審資料。
    const landingPaidPrices = BILLING_PLAN_ORDER
      .map(id => BILLING_PLANS[id])
      .filter(p => !p.internal && !p.landingHidden && p.priceMonthly != null && p.priceMonthly > 0)
      .map(p => p.priceMonthly)
    expect(landingPaidPrices).toEqual([399, 799, 1499])
  })

  it('只有 enterprise 是客製方案', () => {
    for (const id of BILLING_PLAN_ORDER) {
      expect(BILLING_PLANS[id].custom).toBe(id === 'enterprise')
    }
  })

  it('測試 / 內部方案:無限額度、標記 internal(僅 super admin 指派)', () => {
    for (const id of ['test', 'internal'] as BillingPlanId[]) {
      expect(BILLING_PLANS[id].answeredQuota).toBeNull()
      expect(BILLING_PLANS[id].internal).toBe(true)
      expect(effectiveAnsweredQuota(BILLING_PLANS[id])).toBeNull() // 無上限
    }
    // 對外方案不得誤標 internal
    for (const id of ['free', 'lite', 'starter', 'growth', 'pro', 'enterprise'] as BillingPlanId[]) {
      expect(BILLING_PLANS[id].internal).toBeFalsy()
    }
  })
})

describe('getBillingPlan', () => {
  it('取得對應方案', () => {
    expect(getBillingPlan('pro').id).toBe('pro')
  })

  it('未知 / 缺省一律退回免費層', () => {
    expect(getBillingPlan(undefined).id).toBe(DEFAULT_BILLING_PLAN_ID)
    expect(getBillingPlan(null).id).toBe('free')
    expect(getBillingPlan('nonsense').id).toBe('free')
  })
})

describe('effectiveAnsweredQuota', () => {
  it('無 override 時用方案預設', () => {
    expect(effectiveAnsweredQuota(BILLING_PLANS.starter)).toBe(1300)
  })

  it('override 覆蓋方案預設（含企業客製從 null 變有值）', () => {
    expect(effectiveAnsweredQuota(BILLING_PLANS.pro, 50_000)).toBe(50_000)
    expect(effectiveAnsweredQuota(BILLING_PLANS.enterprise, 30_000)).toBe(30_000)
  })

  it('企業無 override 時不設額度上限（null）', () => {
    expect(effectiveAnsweredQuota(BILLING_PLANS.enterprise)).toBeNull()
  })
})
