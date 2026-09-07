/**
 * 方案功能閘門與額度階梯的守門測試（`D-69`）。
 *
 * 為什麼要有：這幾個欄位在 2026-09-07 以前**只印在方案表上、後端零攔截**，
 * 沒有任何測試看著它們。把「哪個方案有什麼」寫成斷言，改錯就會紅。
 */
import { describe, expect, it } from 'vitest'
import {
  BILLING_PLANS,
  FEATURED_PLAN_IDS,
  OVERAGE_PER_REPLY_TWD,
  planAllowsBroadcast,
  planAllowsReport,
  planAllowsScripting,
  planLimitMessage,
} from './plans'

describe('額度階梯（D-69 拍板①）', () => {
  it('免費層必須嚴格小於最低付費方案——同量的話付費方案賣不動', () => {
    expect(BILLING_PLANS.free.answeredQuota!).toBeLessThan(BILLING_PLANS.lite.answeredQuota!)
  })

  it('回覆則數與知識量在檯面上的四個方案都逐級遞增', () => {
    const quotas = FEATURED_PLAN_IDS.map(id => BILLING_PLANS[id].answeredQuota!)
    const chunks = FEATURED_PLAN_IDS.map(id => BILLING_PLANS[id].knowledgeChunks!)
    expect(quotas).toEqual([...quotas].sort((a, b) => a - b))
    expect(chunks).toEqual([...chunks].sort((a, b) => a - b))
  })

  it('每則單價隨方案變便宜（買越多越划算，這是升級的數學理由）', () => {
    const paid = ['lite', 'starter', 'growth'] as const
    const unit = paid.map(id => BILLING_PLANS[id].priceMonthly! / BILLING_PLANS[id].answeredQuota!)
    expect(unit[1]).toBeLessThan(unit[0]!)
    expect(unit[2]).toBeLessThan(unit[1]!)
  })

  /**
   * 這條是 `D-69` 拍板②的整個理由，值得一條測試釘住：
   * 超量加購若比「升一級」便宜，客人就永遠卡在低階方案。
   */
  it('長期超量必須比升級貴——否則階梯推不動人', () => {
    const lite = BILLING_PLANS.lite
    const starter = BILLING_PLANS.starter
    const extra = starter.answeredQuota! - lite.answeredQuota!
    const costViaOverage = lite.priceMonthly! + extra * OVERAGE_PER_REPLY_TWD
    expect(costViaOverage).toBeGreaterThan(starter.priceMonthly!)
  })
})

describe('功能閘門（D-69 拍板④）', () => {
  it('腳本：免費與輕量沒有，入門起才有', () => {
    expect(planAllowsScripting(BILLING_PLANS.free)).toBe(false)
    expect(planAllowsScripting(BILLING_PLANS.lite)).toBe(false)
    expect(planAllowsScripting(BILLING_PLANS.starter)).toBe(true)
    expect(planAllowsScripting(BILLING_PLANS.growth)).toBe(true)
  })

  it('群發：免費完全不能發；輕量可全體推播但不能分眾；成長才有分眾', () => {
    expect(planAllowsBroadcast(BILLING_PLANS.free, 'basic')).toBe(false)
    expect(planAllowsBroadcast(BILLING_PLANS.lite, 'basic')).toBe(true)
    expect(planAllowsBroadcast(BILLING_PLANS.lite, 'advanced')).toBe(false)
    expect(planAllowsBroadcast(BILLING_PLANS.growth, 'advanced')).toBe(true)
  })

  it('報表：等級可比較，export 是最高階', () => {
    expect(planAllowsReport(BILLING_PLANS.free, 'advanced')).toBe(false)
    expect(planAllowsReport(BILLING_PLANS.growth, 'advanced')).toBe(true)
    expect(planAllowsReport(BILLING_PLANS.growth, 'export')).toBe(false)
    expect(planAllowsReport(BILLING_PLANS.enterprise, 'export')).toBe(true)
  })

  it('內部／企業方案一律不受限（席次與知識量都是 null）', () => {
    for (const id of ['enterprise', 'test', 'internal'] as const) {
      expect(BILLING_PLANS[id].seats).toBeNull()
      expect(BILLING_PLANS[id].knowledgeChunks).toBeNull()
    }
  })
})

describe('撞上限的訊息', () => {
  /**
   * ⛔ 只說「已達上限」等於沒說——客人只能來問客服。
   * 三個數字都要在：現在幾個、上限幾個、方案叫什麼。
   */
  it('把現況、上限、方案名都講出來，並給出路', () => {
    const msg = planLimitMessage('團隊成員數', 2, 2, '輕量')
    expect(msg).toContain('2／2')
    expect(msg).toContain('輕量')
    expect(msg).toMatch(/升級/)
  })
})
