import { describe, expect, it } from 'vitest'
import { summarizePaymentMonth, type PaymentMonthRow } from './payment'

/**
 * 金流總覽「本月」摘要的算式。
 *
 * 起因:2026-08-17 老闆看超管金流總覽抓到——八月唯一一筆成交 NT$399 已經按過「記退款」、
 * 發票也作廢了,表格那列標著「已退款」,上面的「本月營收」卻仍顯示 NT$399。
 * 同一頁兩套算法:表格看 manualRefundTotal,摘要只看 status==='paid'。
 */

// 台灣時區時間 → ms。summarizePaymentMonth 內部用 taipeiYyyyMm 分桶,所以測資要跨得過月界。
const tpe = (y: number, m: number, d: number, hh = 12, mm = 0) =>
  Date.UTC(y, m - 1, d, hh - 8, mm)

const paid = (amount: number, at: number, refunded?: number): PaymentMonthRow =>
  ({ status: 'paid', amount, paidAt: at, createdAt: at, manualRefundTotal: refunded ?? null })

describe('summarizePaymentMonth', () => {
  it('全額退款的訂單不算營收（老闆抓到的那筆:399 已退 399 → 營收 0）', () => {
    const s = summarizePaymentMonth([paid(399, tpe(2026, 8, 17, 1, 34), 399)], '202608')
    expect(s.monthRevenue).toBe(0)
    // 算式兩端要留著,畫面才寫得出「已請款 399 − 已退款 399」——只給 0 會被當成壞掉
    expect(s.monthCharged).toBe(399)
    expect(s.monthRefunded).toBe(399)
    // 「成交」仍是 1 筆(交易確實發生過),但要看得出其中有退款
    expect(s.monthPaidCount).toBe(1)
    expect(s.monthRefundedCount).toBe(1)
  })

  it('部分退款只扣退掉的那部分', () => {
    const s = summarizePaymentMonth([paid(499, tpe(2026, 8, 5), 100)], '202608')
    expect(s.monthRevenue).toBe(399)
    expect(s.monthRefunded).toBe(100)
    expect(s.monthRefundedCount).toBe(1)
  })

  it('沒退款時營收＝請款金額,且不標任何退款筆數', () => {
    const s = summarizePaymentMonth([paid(399, tpe(2026, 8, 3)), paid(799, tpe(2026, 8, 9))], '202608')
    expect(s.monthRevenue).toBe(1198)
    expect(s.monthRefunded).toBe(0)
    expect(s.monthRefundedCount).toBe(0)
    expect(s.monthPaidCount).toBe(2)
  })

  it('退款金額大於原請款(資料歪掉)也不會讓營收變負數', () => {
    const s = summarizePaymentMonth([paid(399, tpe(2026, 8, 17), 999)], '202608')
    expect(s.monthRevenue).toBe(0)
    expect(s.monthRefunded).toBe(399)
  })

  it('刻意不看發票折讓:折讓與記退款是同一筆退款的兩本帳,兩個都扣會扣兩次', () => {
    // 這筆同時開了折讓又記了退款(實務上很常見:先開折讓沖稅、再記錢的那半邊)
    const row = { ...paid(399, tpe(2026, 8, 17), 399), invoiceAllowanceTotal: 399 } as PaymentMonthRow
    expect(summarizePaymentMonth([row], '202608').monthRevenue).toBe(0) // 不是 -399
  })

  it('只算本月:七月的單(含已退款)不影響八月', () => {
    const rows = [
      paid(399, tpe(2026, 8, 17, 1, 34), 399), // 八月,已退
      paid(499, tpe(2026, 7, 24, 17, 7), 499), // 七月,已退
      paid(499, tpe(2026, 7, 24, 15, 31), 499), // 七月,已退
    ]
    const aug = summarizePaymentMonth(rows, '202608')
    expect(aug.monthPaidCount).toBe(1)
    expect(aug.monthCharged).toBe(399)

    // 退款掛在「成交的那個月」——退七月的單,七月自己降,不會在八月冒出負數
    const jul = summarizePaymentMonth(rows, '202607')
    expect(jul.monthPaidCount).toBe(2)
    expect(jul.monthCharged).toBe(998)
    expect(jul.monthRevenue).toBe(0)
  })

  it('台灣時區月界:8/1 00:30(台灣)算八月,不因 UTC 還在 7/31 被歸到七月', () => {
    const s = summarizePaymentMonth([paid(399, tpe(2026, 8, 1, 0, 30))], '202608')
    expect(s.monthPaidCount).toBe(1)
    expect(summarizePaymentMonth([paid(399, tpe(2026, 8, 1, 0, 30))], '202607').monthPaidCount).toBe(0)
  })

  it('失敗只數筆數不進金額;逾期／待付款兩邊都不算', () => {
    const rows: PaymentMonthRow[] = [
      paid(399, tpe(2026, 8, 17)),
      { status: 'failed', amount: 499, createdAt: tpe(2026, 8, 10) },
      { status: 'failed', amount: 499, createdAt: tpe(2026, 8, 10, 12, 2) }, // 同一筆重試
      { status: 'expired', amount: 4990, createdAt: tpe(2026, 8, 11) },
      { status: 'pending', amount: 799, createdAt: tpe(2026, 8, 12) },
    ]
    const s = summarizePaymentMonth(rows, '202608')
    expect(s.monthFailedCount).toBe(2)
    expect(s.monthRevenue).toBe(399)
    expect(s.monthPaidCount).toBe(1)
  })

  it('沒有時間戳的訂單直接跳過,不會被算進任何月份', () => {
    const s = summarizePaymentMonth([{ status: 'paid', amount: 399, paidAt: null, createdAt: null }], '202608')
    expect(s.monthPaidCount).toBe(0)
    expect(s.monthRevenue).toBe(0)
  })
})
