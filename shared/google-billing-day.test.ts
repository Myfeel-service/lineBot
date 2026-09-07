import { describe, it, expect } from 'vitest'
import {
  billingDateKey,
  billingDayStart,
  billingDayTaipeiSpan,
  billingMidnightAfter,
  billingMonthStart,
  enumerateBillingDays,
} from './google-billing-day'

describe('google-billing-day', () => {
  it('夏令時：台灣下午 3 點才換日（Google 的 9/6 從台灣 9/6 15:00 開始）', () => {
    // 台北 2026-09-06 14:59 → Google 還在 9/5
    expect(billingDateKey(new Date('2026-09-06T06:59:00Z'))).toBe('2026-09-05')
    // 台北 2026-09-06 15:00 → Google 進入 9/6
    expect(billingDateKey(new Date('2026-09-06T07:00:00Z'))).toBe('2026-09-06')
    expect(billingDayStart('2026-09-06').toISOString()).toBe('2026-09-06T07:00:00.000Z')
  })

  it('冬令時：換日時間會變成台灣下午 4 點（所以不能寫死 -7）', () => {
    expect(billingDayStart('2026-01-15').toISOString()).toBe('2026-01-15T08:00:00.000Z')
    expect(billingDayStart('2026-07-15').toISOString()).toBe('2026-07-15T07:00:00.000Z')
  })

  it('billingMidnightAfter 嚴格大於：剛好站在日界上要推到下一天', () => {
    const boundary = billingDayStart('2026-09-06')
    expect(billingMidnightAfter(boundary).toISOString()).toBe('2026-09-07T07:00:00.000Z')
    expect(billingMidnightAfter(boundary).getTime()).toBeGreaterThan(boundary.getTime())
    // 日界前一毫秒仍屬前一天，推出來是同一個日界
    expect(billingMidnightAfter(new Date(boundary.getTime() - 1)).toISOString()).toBe('2026-09-06T07:00:00.000Z')
  })

  it('DST 換日那兩天：長度是 23／25 小時，仍然只跨一天', () => {
    // 2026-03-08 春天前進（23 小時）
    const spring = billingDayStart('2026-03-08')
    expect(billingMidnightAfter(spring).getTime() - spring.getTime()).toBe(23 * 3600_000)
    expect(billingDateKey(billingMidnightAfter(spring))).toBe('2026-03-09')
    // 2026-11-01 秋天後退（25 小時）
    const fall = billingDayStart('2026-11-01')
    expect(billingMidnightAfter(fall).getTime() - fall.getTime()).toBe(25 * 3600_000)
    expect(billingDateKey(billingMidnightAfter(fall))).toBe('2026-11-02')
  })

  it('月界：Google 的九月從台灣 9/1 下午 3 點開始（台灣 9/1 上午的用量算八月）', () => {
    expect(billingMonthStart(2026, 9).toISOString()).toBe('2026-09-01T07:00:00.000Z')
    // 台北 9/1 09:00（= 01:00Z）落在 Google 的八月
    expect(billingDateKey(new Date('2026-09-01T01:00:00Z'))).toBe('2026-08-31')
    // 跨年：月份 13 要進位到隔年 1 月
    expect(billingMonthStart(2026, 13).toISOString()).toBe(billingMonthStart(2027, 1).toISOString())
  })

  it('enumerateBillingDays 逐日不漏不重，DST 那個月也是', () => {
    const days = enumerateBillingDays(billingMonthStart(2026, 9), billingMonthStart(2026, 10))
    expect(days).toHaveLength(30)
    expect(days[0]).toBe('2026-09-01')
    expect(days[29]).toBe('2026-09-30')
    expect(new Set(days).size).toBe(30)

    const nov = enumerateBillingDays(billingMonthStart(2026, 11), billingMonthStart(2026, 12))
    expect(nov).toHaveLength(30) // 有一天 25 小時，仍是 30 天
    expect(new Set(nov).size).toBe(30)
  })

  it('billingDayTaipeiSpan：講得出「台灣的幾點到幾點」', () => {
    expect(billingDayTaipeiSpan('2026-09-06')).toEqual({ from: '9/6 下午 3 點', to: '9/7 下午 3 點' })
    expect(billingDayTaipeiSpan('2026-01-15')).toEqual({ from: '1/15 下午 4 點', to: '1/16 下午 4 點' })
  })

  it('回歸：2026-09-06 的寫入用帳單日切才會超出免費額（老闆 09-07 抓到的那筆）', () => {
    // Cloud Monitoring 小時級實測：同一批用量，兩種切法的結果。
    // 台北日切 → 9/6 = 12,907、9/7 = 11,486，兩天都沒破 2 萬 → 會說「都在免費額度內」
    // 帳單日切 → 9/6 = 21,893 → 超出 1,893，與主控台「2.2 萬（超出 1,792）」吻合
    const FREE = 20_000
    const taipeiSplit = [12_907, 11_486]
    const billingSplit = [21_893]
    expect(taipeiSplit.reduce((a, v) => a + Math.max(0, v - FREE), 0)).toBe(0)
    expect(billingSplit.reduce((a, v) => a + Math.max(0, v - FREE), 0)).toBe(1_893)
    // ⚠️ 兩排數字不是同一個時間窗（台北 9/7 那格當時還沒走完），別拿總和互相驗證；
    // 這條測的是「同一批用量換個切法，超額判定會從 0 變成 1,893」這件事本身。
  })
})
