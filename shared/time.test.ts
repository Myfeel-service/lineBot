import { describe, expect, it } from 'vitest'
import { addDays, anchoredPeriod, dayOfDate, isServiceDayOff, isServiceHoursDnd, nextAnchoredPeriod, normalizeAnchorDay, taipeiDate, taipeiYyyyMm } from './time'

describe('taipeiYyyyMm（成本報表的月結桶）', () => {
  it('月中:UTC 與台灣同月', () => {
    expect(taipeiYyyyMm(new Date('2026-07-13T00:00:00Z'))).toBe('202607')
  })
  it('月底跨時區:UTC 7/31 18:00 = 台灣 8/1 02:00 → 算 8 月', () => {
    expect(taipeiYyyyMm(new Date('2026-07-31T18:00:00Z'))).toBe('202608')
  })
  it('UTC 7/31 15:00 = 台灣 7/31 23:00 → 仍算 7 月', () => {
    expect(taipeiYyyyMm(new Date('2026-07-31T15:00:00Z'))).toBe('202607')
  })
})

describe('taipeiDate', () => {
  it('月中同日', () => {
    expect(taipeiDate(new Date('2026-07-13T00:00:00Z'))).toBe('2026-07-13')
  })
  it('UTC 7/31 18:00 = 台灣 8/1 → 進到隔天', () => {
    expect(taipeiDate(new Date('2026-07-31T18:00:00Z'))).toBe('2026-08-01')
  })
})

describe('日曆小工具', () => {
  it('dayOfDate', () => {
    expect(dayOfDate('2026-07-28')).toBe(28)
    expect(dayOfDate('2026-07-01')).toBe(1)
  })
  it('addDays 跨月 / 跨年', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01')
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('normalizeAnchorDay 夾到 1–31', () => {
    expect(normalizeAnchorDay(28)).toBe(28)
    expect(normalizeAnchorDay(0)).toBe(1)
    expect(normalizeAnchorDay(99)).toBe(31)
    expect(normalizeAnchorDay(undefined)).toBe(1)
  })
})

describe('anchoredPeriod（訂閱週期 = 錨定日制）', () => {
  it('月底訂閱 → 拿到完整一期,不是「只買到月底剩幾天」', () => {
    // 這一行就是修掉「7/28 付 799 卻只用到 7/31」的地方
    expect(anchoredPeriod('2026-07-28', 28)).toEqual({ start: '2026-07-28', end: '2026-08-27' })
  })
  it('月初訂閱', () => {
    expect(anchoredPeriod('2026-07-01', 1)).toEqual({ start: '2026-07-01', end: '2026-07-31' })
  })
  it('跨年', () => {
    expect(anchoredPeriod('2026-12-15', 15)).toEqual({ start: '2026-12-15', end: '2027-01-14' })
  })
  it('錨定日 31 遇 2 月 → 夾到當月最後一天', () => {
    expect(anchoredPeriod('2026-01-31', 31)).toEqual({ start: '2026-01-31', end: '2026-02-27' })
    expect(anchoredPeriod('2028-01-31', 31)).toEqual({ start: '2028-01-31', end: '2028-02-28' }) // 閏年
  })
  it('起日早於本月錨定日（期中降級 → 一段短的過渡期）', () => {
    expect(anchoredPeriod('2026-07-15', 28)).toEqual({ start: '2026-07-15', end: '2026-07-27' })
  })
})

describe('nextAnchoredPeriod（續期）', () => {
  it('接在到期日隔天,不留空隙也不重疊', () => {
    const p1 = anchoredPeriod('2026-07-28', 28)
    const p2 = nextAnchoredPeriod(p1, 28)
    expect(p2).toEqual({ start: '2026-08-28', end: '2026-09-27' })
    expect(p2.start).toBe(addDays(p1.end, 1))
  })

  it('錨定日 31 被短月夾過之後會回到 31，不會一路往前漂', () => {
    // 這就是「錨定日必須單獨存起來、不能從上一期起日反推」的理由
    let p = anchoredPeriod('2026-01-31', 31) // 1/31 ~ 2/27
    p = nextAnchoredPeriod(p, 31)
    expect(p).toEqual({ start: '2026-02-28', end: '2026-03-30' }) // 被 2 月夾成 28
    p = nextAnchoredPeriod(p, 31)
    expect(p).toEqual({ start: '2026-03-31', end: '2026-04-29' }) // 回到 31 ✓
  })

  it('連滾 12 期不會漂移或斷檔', () => {
    let p = anchoredPeriod('2026-07-28', 28)
    for (let i = 0; i < 12; i++) {
      const next = nextAnchoredPeriod(p, 28)
      expect(next.start).toBe(addDays(p.end, 1)) // 不留空隙
      p = next
    }
    expect(p.start).toBe('2027-07-28') // 一年後仍回到錨定日
  })
})

describe('isServiceHoursDnd（服務時間 / 勿擾時段，台灣時區）', () => {
  // 2026-07-20 是週一；07-18 週六、07-19 週日。日期以 UTC 給，函式會 +8 轉台灣。
  const svc = { enabled: true, start: '09:00', end: '18:00', weekendOff: true }

  it('關閉時一律回 false（不影響任何行為）', () => {
    const off = { ...svc, enabled: false }
    expect(isServiceHoursDnd(off, new Date('2026-07-20T20:00:00Z'))).toBe(false) // 台灣 04:00 深夜也不擋
    expect(isServiceHoursDnd(null)).toBe(false)
    expect(isServiceHoursDnd(undefined)).toBe(false)
  })

  it('平日服務時段內 → 非勿擾', () => {
    // UTC 02:00 = 台灣週一 10:00
    expect(isServiceHoursDnd(svc, new Date('2026-07-20T02:00:00Z'))).toBe(false)
  })

  it('平日服務時段後 → 勿擾', () => {
    // UTC 12:00 = 台灣週一 20:00
    expect(isServiceHoursDnd(svc, new Date('2026-07-20T12:00:00Z'))).toBe(true)
  })

  it('平日開店前 → 勿擾（跨 UTC 日：UTC 週日 23:00 = 台灣週一 07:00）', () => {
    expect(isServiceHoursDnd(svc, new Date('2026-07-19T23:00:00Z'))).toBe(true)
  })

  it('週末休息時，週六整天勿擾（即使落在時段內）', () => {
    // UTC 02:00 = 台灣週六 10:00
    expect(isServiceHoursDnd(svc, new Date('2026-07-18T02:00:00Z'))).toBe(true)
  })

  it('週末不休息時，週六時段內 → 非勿擾', () => {
    const noWeekend = { ...svc, weekendOff: false }
    expect(isServiceHoursDnd(noWeekend, new Date('2026-07-18T02:00:00Z'))).toBe(false)
  })

  it('跨夜時段 22:00–06:00：深夜在服務中、白天才勿擾', () => {
    const overnight = { enabled: true, start: '22:00', end: '06:00', weekendOff: false }
    expect(isServiceHoursDnd(overnight, new Date('2026-07-20T15:00:00Z'))).toBe(false) // 台灣週一 23:00 服務中
    expect(isServiceHoursDnd(overnight, new Date('2026-07-19T19:00:00Z'))).toBe(false) // 台灣週一 03:00 服務中
    expect(isServiceHoursDnd(overnight, new Date('2026-07-20T04:00:00Z'))).toBe(true) // 台灣週一 12:00 勿擾
  })

  it('設定壞掉（時間格式非法）→ 回 false，寧可不擋', () => {
    const bad = { enabled: true, start: '25:99', end: '18:00', weekendOff: false }
    expect(isServiceHoursDnd(bad, new Date('2026-07-20T12:00:00Z'))).toBe(false)
  })
})

describe('isServiceDayOff（整天休假，只看週末不看鐘點）', () => {
  const svc = { enabled: true, start: '09:00', end: '18:00', weekendOff: true }

  it('週六、週日整天都算休假（時段內外都一樣）', () => {
    expect(isServiceDayOff(svc, new Date('2026-07-18T02:00:00Z'))).toBe(true) // 台灣週六 10:00
    expect(isServiceDayOff(svc, new Date('2026-07-18T12:00:00Z'))).toBe(true) // 台灣週六 20:00
    expect(isServiceDayOff(svc, new Date('2026-07-19T02:00:00Z'))).toBe(true) // 台灣週日 10:00
  })

  it('平日不算休假——包含服務時段之外的鐘點（這正是它和勿擾的差別）', () => {
    expect(isServiceDayOff(svc, new Date('2026-07-20T02:00:00Z'))).toBe(false) // 台灣週一 10:00
    expect(isServiceDayOff(svc, new Date('2026-07-20T12:00:00Z'))).toBe(false) // 台灣週一 20:00（勿擾但不是休假）
    expect(isServiceHoursDnd(svc, new Date('2026-07-20T12:00:00Z'))).toBe(true)
  })

  it('週末照常服務 / 沒啟用服務時間 → 一律不算休假', () => {
    expect(isServiceDayOff({ ...svc, weekendOff: false }, new Date('2026-07-18T02:00:00Z'))).toBe(false)
    expect(isServiceDayOff({ ...svc, enabled: false }, new Date('2026-07-18T02:00:00Z'))).toBe(false)
    expect(isServiceDayOff(null)).toBe(false)
    expect(isServiceDayOff(undefined)).toBe(false)
  })

  it('台灣時區為準：UTC 週五晚上已是台灣週六', () => {
    expect(isServiceDayOff(svc, new Date('2026-07-17T16:00:00Z'))).toBe(true) // 台灣週六 00:00
    expect(isServiceDayOff(svc, new Date('2026-07-17T15:00:00Z'))).toBe(false) // 台灣週五 23:00
  })
})
