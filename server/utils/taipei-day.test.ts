import { describe, expect, it } from 'vitest'
import { taipeiDateKey, taipeiDayEnd, taipeiDayStart } from './taipei-day'

/**
 * 這組測試守的是「昨日摘要 18 vs 16」那個坑：日期參數的日界線必須是台北時間，
 * 而且不受**執行環境**時區影響（正式在 UTC Lambda、本機在台北，舊寫法兩邊各錯一種）。
 */
describe('taipei-day', () => {
  it('YYYY-MM-DD 解析成台北日界線(不吃執行環境時區)', () => {
    // 台北 8/6 00:00 = UTC 8/5 16:00
    expect(taipeiDayStart('2026-08-06')!.toISOString()).toBe('2026-08-05T16:00:00.000Z')
    // 台北 8/6 23:59:59.999 = UTC 8/6 15:59:59.999
    expect(taipeiDayEnd('2026-08-06')!.toISOString()).toBe('2026-08-06T15:59:59.999Z')
  })

  it('實測的兩場漏網之魚:台北 8/7 凌晨開的場,不屬於 8/6 的窗', () => {
    // 舊寫法在 UTC 伺服器上 endDate=8/6 23:59:59Z=台北 8/7 07:59,這兩場會被算進 8/6
    const tpe0807_0006 = new Date('2026-08-06T16:06:00Z') // 台北 8/7 00:06
    expect(tpe0807_0006 > taipeiDayEnd('2026-08-06')!).toBe(true)
    expect(taipeiDateKey(tpe0807_0006)).toBe('2026-08-07')
  })

  it('台北 8/6 凌晨開的場,屬於 8/6(舊寫法的窗從 08:00 才開始,會漏掉)', () => {
    const tpe0806_0300 = new Date('2026-08-05T19:00:00Z') // 台北 8/6 03:00
    expect(tpe0806_0300 >= taipeiDayStart('2026-08-06')!).toBe(true)
    expect(taipeiDateKey(tpe0806_0300)).toBe('2026-08-06')
  })

  it('格式不對回 null(呼叫端 fallback 成預設區間,不會丟 Invalid Date 進 Firestore)', () => {
    expect(taipeiDayStart(undefined)).toBeNull()
    expect(taipeiDayStart('')).toBeNull()
    expect(taipeiDayStart('2026/08/06')).toBeNull()
    expect(taipeiDayStart('2026-08-06T12:00:00Z')).toBeNull()
  })
})
