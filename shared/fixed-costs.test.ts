import { describe, expect, it } from 'vitest'
import {
  FIXED_COST_MAX_ITEMS,
  fixedCostAmountText,
  fixedCostMonthlyTwd,
  fixedCostRenewalPassed,
  fixedCostsMonthlyTwd,
  parseFixedCostItem,
  parseFixedCostItems,
} from './fixed-costs'
import { USD_TO_TWD } from './usd-twd'

/** 成本總覽的手填固定支出（`D-47`③）：存檔前的檢查與「攤到每月」的算法 */
const domain = { id: 'a', name: '網域 lineminime.com（GoDaddy）', amount: 840, currency: 'TWD', cycle: 'yearly', renewsOn: '2027-07-13' }

describe('攤到每月', () => {
  it('年繳 ÷12、月繳照原數', () => {
    expect(fixedCostMonthlyTwd({ amount: 840, currency: 'TWD', cycle: 'yearly' })).toBe(70)
    expect(fixedCostMonthlyTwd({ amount: 150, currency: 'TWD', cycle: 'monthly' })).toBe(150)
  })

  it('美金照全站同一個匯率換', () => {
    expect(fixedCostMonthlyTwd({ amount: 5, currency: 'USD', cycle: 'monthly' })).toBe(5 * USD_TO_TWD)
    expect(fixedCostMonthlyTwd({ amount: 24, currency: 'USD', cycle: 'yearly' })).toBe(2 * USD_TO_TWD)
  })

  it('全部加起來才四捨五入（不是每筆先捨入再加）', () => {
    const items = [
      { ...domain, id: 'a', amount: 100 }, // 8.33
      { ...domain, id: 'b', amount: 100 }, // 8.33
      { ...domain, id: 'c', amount: 100 }, // 8.33
    ] as never
    expect(fixedCostsMonthlyTwd(items)).toBe(25)
  })

  it('講給人看的原始金額', () => {
    expect(fixedCostAmountText({ amount: 840, currency: 'TWD', cycle: 'yearly' })).toBe('NT$840／年')
    expect(fixedCostAmountText({ amount: 3.5, currency: 'USD', cycle: 'monthly' })).toBe('US$3.5／月')
  })
})

describe('存檔前的檢查', () => {
  it('合格的那筆原樣收下（續約日沒填＝null）', () => {
    expect(parseFixedCostItem(domain)).toEqual({ ok: true, item: domain })
    const r = parseFixedCostItem({ ...domain, renewsOn: '' })
    expect(r.ok && r.item.renewsOn).toBe(null)
  })

  it('講得出錯在哪一格', () => {
    expect(parseFixedCostItem({ ...domain, name: '  ' })).toEqual({ ok: false, error: '名稱沒填' })
    expect(parseFixedCostItem({ ...domain, amount: 0 })).toMatchObject({ ok: false, error: expect.stringContaining('金額要大於 0') })
    expect(parseFixedCostItem({ ...domain, amount: 'abc' })).toMatchObject({ ok: false })
    expect(parseFixedCostItem({ ...domain, amount: 5_000_000 })).toMatchObject({ ok: false, error: expect.stringContaining('太大') })
    expect(parseFixedCostItem({ ...domain, currency: 'JPY' })).toMatchObject({ ok: false, error: expect.stringContaining('幣別') })
    expect(parseFixedCostItem({ ...domain, cycle: 'weekly' })).toMatchObject({ ok: false, error: expect.stringContaining('每年或每月') })
    expect(parseFixedCostItem({ ...domain, renewsOn: '2027/07/13' })).toMatchObject({ ok: false, error: expect.stringContaining('續約日') })
  })

  it('⛔ 整份裡有一筆不合格就整份退回，不默默丟掉那一筆', () => {
    const r = parseFixedCostItems([domain, { ...domain, id: 'b', amount: -1 }])
    expect(r.ok).toBe(false)
  })

  it('上限 20 筆；id 撞了兩筆都留著', () => {
    expect(parseFixedCostItems(Array.from({ length: FIXED_COST_MAX_ITEMS + 1 }, (_, i) => ({ ...domain, id: `x${i}` }))).ok).toBe(false)
    const r = parseFixedCostItems([domain, { ...domain }])
    expect(r.ok && r.items.map(i => i.id)).toEqual(['a', 'a_1'])
  })
})

describe('續約日過了要提醒', () => {
  it('今天之前＝過了；今天當天、沒填都不算', () => {
    expect(fixedCostRenewalPassed({ renewsOn: '2026-10-19' }, '2026-10-20')).toBe(true)
    expect(fixedCostRenewalPassed({ renewsOn: '2026-10-20' }, '2026-10-20')).toBe(false)
    expect(fixedCostRenewalPassed({ renewsOn: null }, '2026-10-20')).toBe(false)
  })
})
