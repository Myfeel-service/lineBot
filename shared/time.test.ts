import { describe, expect, it } from 'vitest'
import { addDays, anchoredPeriod, appendServiceHoursLine, dayOfDate, dndSentence, isServiceDayOff, isServiceHoursDnd, mdw, nextAnchoredPeriod, nextServiceStartMs, normalizeAnchorDay, serviceHoursSentence, taipeiDate, taipeiMdwHm, taipeiYyyyMm } from './time'

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

/**
 * 勿擾訊息只說「目前非客服服務時間」，客人無從得知要等多久（`H-19`：那位客人因此
 * 在 41 秒內按了 34 次選單）。這句話就是補上「等到什麼時候」的那半。
 */
describe('serviceHoursSentence（把服務時間講成一句人話）', () => {
  it('週末休息 → 講「週一至週五」', () => {
    expect(serviceHoursSentence({ enabled: true, start: '10:00', end: '19:00', weekendOff: true, holidayOff: false }))
      .toBe('週一至週五 10:00–19:00')
  })

  it('國定假日休息 → 後面補「（國定假日休息）」；沒設過（舊資料）＝跟週末一樣', () => {
    expect(serviceHoursSentence({ enabled: true, start: '10:00', end: '19:00', weekendOff: true, holidayOff: true }))
      .toBe('週一至週五 10:00–19:00（國定假日休息）')
    expect(serviceHoursSentence({ enabled: true, start: '10:00', end: '19:00', weekendOff: true }))
      .toBe('週一至週五 10:00–19:00（國定假日休息）')
    expect(serviceHoursSentence({ enabled: true, start: '10:00', end: '19:00', weekendOff: false }))
      .toBe('每天 10:00–19:00')
  })

  it('週末不休息 → 講「每天」', () => {
    expect(serviceHoursSentence({ enabled: true, start: '10:00', end: '19:00', weekendOff: false }))
      .toBe('每天 10:00–19:00')
  })

  it('存成 "9:00" 也要唸成 "09:00"（跟設定畫面顯示的一致）', () => {
    expect(serviceHoursSentence({ enabled: true, start: '9:00', end: '18:30', weekendOff: false }))
      .toBe('每天 09:00–18:30')
  })

  it('沒開服務時間 → 沒有這句（不是講「每天 00:00」）', () => {
    expect(serviceHoursSentence({ enabled: false, start: '10:00', end: '19:00', weekendOff: true })).toBeNull()
    expect(serviceHoursSentence(null)).toBeNull()
    expect(serviceHoursSentence(undefined)).toBeNull()
  })

  it('時間格式壞掉 → 沒有這句，不對客人講出半截的話', () => {
    expect(serviceHoursSentence({ enabled: true, start: '25:99', end: '19:00', weekendOff: true })).toBeNull()
  })

  it('起訖同一分鐘（＝整天都不服務）→ 沒有這句', () => {
    // isServiceHoursDnd 對這種設定是「整天勿擾」，照字面唸成「每天 09:00–09:00」只會更困惑
    expect(serviceHoursSentence({ enabled: true, start: '09:00', end: '09:00', weekendOff: false })).toBeNull()
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

/**
 * 國定假日（`D-137`②，2026-10-21）。
 *
 * 情境用 MYFEEL 的真實設定（10:00–19:00、週末休）與 2026 國慶、光復節連假：
 * 10/9（五）國慶補假、10/10（六）國慶日、10/25（日）光復節、10/26（一）光復節補假。
 * MYFEEL 這幾天實際沒上班，系統原本只認得週末——照樣傳摘要、客人收到「將盡快回覆您」。
 */
describe('國定假日也休息', () => {
  /** 台北時間 → Date（台灣沒有夏令時間，固定 +8） */
  const at = (md: string, hm = '11:00') => new Date(`2026-${md}T${hm}:00+08:00`)
  /** 舊資料沒有 holidayOff 這格 */
  const myfeel = { enabled: true, start: '10:00', end: '19:00', weekendOff: true }

  it('沒設過＝跟週末一樣：國定假日的平日整天休', () => {
    expect(isServiceDayOff(myfeel, at('10-09'))).toBe(true)
    expect(isServiceHoursDnd(myfeel, at('10-09'))).toBe(true) // 上班時段也勿擾
    expect(isServiceDayOff(myfeel, at('10-26'))).toBe(true) // 補假也算
  })

  it('只休國定假日的店：國定假日落在週六照樣休（不是因為週末）', () => {
    expect(isServiceDayOff({ ...myfeel, weekendOff: false, holidayOff: true }, at('10-10'))).toBe(true)
  })

  it('一般平日不受影響', () => {
    expect(isServiceDayOff(myfeel, at('10-12'))).toBe(false)
    expect(isServiceHoursDnd(myfeel, at('10-12'))).toBe(false)
  })

  it('明確關掉 → 國定假日照常上班', () => {
    expect(isServiceDayOff({ ...myfeel, holidayOff: false }, at('10-09'))).toBe(false)
  })

  it('週末照常營業、國定假日休息 → 週六的國慶日休，連假裡的週日照常', () => {
    const shop = { ...myfeel, weekendOff: false, holidayOff: true }
    expect(isServiceDayOff(shop, at('10-10'))).toBe(true)
    expect(isServiceDayOff(shop, at('10-11'))).toBe(false)
  })

  it('服務時間沒開 → 國定假日也不算（完全不影響行為）', () => {
    expect(isServiceDayOff({ ...myfeel, enabled: false, holidayOff: true }, at('10-09'))).toBe(false)
  })

  it('勿擾時段講成一句人話時帶上國定假日', () => {
    expect(dndSentence(myfeel)).toBe('19:00–10:00，以及週六、週日與國定假日整天')
    expect(dndSentence({ ...myfeel, holidayOff: false })).toBe('19:00–10:00，以及週六、週日整天')
    expect(dndSentence({ ...myfeel, weekendOff: false, holidayOff: true })).toBe('19:00–10:00，以及國定假日整天')
  })
})

describe('nextServiceStartMs：下次開始服務是什麼時候', () => {
  const at = (md: string, hm: string) => Date.parse(`2026-${md}T${hm}:00+08:00`)
  const myfeel = { enabled: true, start: '10:00', end: '19:00', weekendOff: true }

  it('現在就在服務時間內 → 就是現在', () => {
    expect(nextServiceStartMs(myfeel, at('10-12', '11:00'))).toBe(at('10-12', '11:00'))
  })

  it('國慶連假前一晚 → 跳過補假與週末到週一；當作照常上班算則是隔天早上', () => {
    expect(nextServiceStartMs(myfeel, at('10-08', '20:00'))).toBe(at('10-12', '10:00'))
    expect(nextServiceStartMs(myfeel, at('10-08', '20:00'), { ignoreHolidays: true })).toBe(at('10-09', '10:00'))
  })

  it('光復節連假的週六 → 週二（週一補假）', () => {
    expect(nextServiceStartMs(myfeel, at('10-24', '15:00'))).toBe(at('10-27', '10:00'))
  })

  it('沒開／起訖同一分鐘 → null', () => {
    expect(nextServiceStartMs({ ...myfeel, enabled: false }, at('10-08', '20:00'))).toBeNull()
    expect(nextServiceStartMs({ ...myfeel, start: '10:00', end: '10:00' }, at('10-08', '20:00'))).toBeNull()
  })

  /**
   * 跨夜的服務時間（22:00–06:00）遇國定假日（`C-362`）：放假那天整天勿擾，隔天一過午夜「06:00 以前」就算上班、
   * 會通知同事。原本只看每天的開始時間，跟客人講「10/11（日）22:00 起」——比真的通知同事晚了快一整天。
   */
  it('跨夜服務時間：講的時間＝勿擾真的結束的那一刻（隔天午夜），不是隔天晚上', () => {
    const night = { enabled: true, start: '22:00', end: '06:00', weekendOff: false, holidayOff: true }
    // 10/10（六）國慶日 23:00 → 10/11（日）00:00
    expect(nextServiceStartMs(night, at('10-10', '23:00'))).toBe(at('10-11', '00:00'))
    // 10/9（五）國慶補假 02:00（前一晚那班過了午夜）→ 10/9、10/10 都放，同樣是 10/11 00:00
    expect(nextServiceStartMs(night, at('10-09', '02:00'))).toBe(at('10-11', '00:00'))
    // 講給客人的那一刻，勿擾一定已經結束；前一分鐘還在勿擾
    for (const hm of ['00:00', '00:30', '05:59']) expect(isServiceHoursDnd(night, new Date(at('10-11', hm)))).toBe(false)
    expect(isServiceHoursDnd(night, new Date(at('10-11', '00:00') - 60_000))).toBe(true)
    expect(appendServiceHoursLine('目前非客服服務時間', night, at('10-10', '23:00')))
      .toBe('目前非客服服務時間\n國定假日休息，10/11（日）00:00 起回覆您。')
  })

  it('跨夜服務時間的平常下班時段 → 照舊是當天晚上開始', () => {
    const night = { enabled: true, start: '22:00', end: '06:00', weekendOff: false, holidayOff: true }
    expect(nextServiceStartMs(night, at('10-13', '12:00'))).toBe(at('10-13', '22:00'))
  })
})

describe('日期講法只有一份', () => {
  it('mdw：「2026-10-26」→「10/26（一）」；壞掉的字串原樣回', () => {
    expect(mdw('2026-10-26')).toBe('10/26（一）')
    expect(mdw('not-a-date')).toBe('not-a-date')
  })
  it('taipeiMdwHm：台北時間的日期＋時分（UTC 前一天晚上已是台北隔天）', () => {
    expect(taipeiMdwHm(Date.parse('2026-10-11T16:00:00Z'))).toBe('10/12（一）00:00')
  })
})

/**
 * 客人找真人、遇到勿擾時收到的那則後面補的那行（`H-19`＋`D-137`②）。
 * 因為國定假日才要等更久時改講下次幾號幾點——「服務時間：週一至週五」在國定假日的週五讀起來像說謊。
 */
describe('appendServiceHoursLine：勿擾訊息後面補哪一行', () => {
  const at = (md: string, hm: string) => Date.parse(`2026-${md}T${hm}:00+08:00`)
  const myfeel = { enabled: true, start: '10:00', end: '19:00', weekendOff: true }
  const BASE = '您好，目前非客服服務時間，我們會在服務時間盡快回覆您 🙏'

  it('國定假日當天 → 講下次幾號幾點', () => {
    expect(appendServiceHoursLine(BASE, myfeel, at('10-09', '11:00')))
      .toBe(`${BASE}\n國定假日休息，10/12（一）10:00 起回覆您。`)
  })

  it('放假前一晚、連假裡的週日也講（照「週一至週五」推會推錯）', () => {
    expect(appendServiceHoursLine(BASE, myfeel, at('10-08', '20:00')))
      .toBe(`${BASE}\n國定假日休息，10/12（一）10:00 起回覆您。`)
    expect(appendServiceHoursLine(BASE, myfeel, at('10-25', '15:00')))
      .toBe(`${BASE}\n國定假日休息，10/27（二）10:00 起回覆您。`)
  })

  it('國定假日落在週末、下次上班本來就是週一 → 照舊講服務時間', () => {
    expect(appendServiceHoursLine(BASE, myfeel, at('10-10', '15:00')))
      .toBe(`${BASE}\n服務時間：週一至週五 10:00–19:00（國定假日休息）`)
  })

  it('一般的下班時間 → 照舊', () => {
    expect(appendServiceHoursLine(BASE, myfeel, at('10-13', '20:00')))
      .toBe(`${BASE}\n服務時間：週一至週五 10:00–19:00（國定假日休息）`)
  })

  it('國定假日照常上班的店 → 不講國定假日', () => {
    expect(appendServiceHoursLine(BASE, { ...myfeel, holidayOff: false }, at('10-08', '20:00')))
      .toBe(`${BASE}\n服務時間：週一至週五 10:00–19:00`)
  })

  it('店家文案自己寫了時間：平常不重複補；國定假日照樣講日期（他的文案不會知道今年哪天放假）', () => {
    const own = '目前非服務時間，我們 10:00 後回覆您'
    expect(appendServiceHoursLine(own, myfeel, at('10-13', '20:00'))).toBe(own)
    expect(appendServiceHoursLine(own, myfeel, at('10-09', '11:00')))
      .toBe(`${own}\n國定假日休息，10/12（一）10:00 起回覆您。`)
  })
})
