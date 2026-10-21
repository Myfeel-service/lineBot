/**
 * 每日摘要「這一則要講哪幾天」（`D-137`①）。
 *
 * 要守的只有一件事：**每一天都剛好被某一則講到一次**——不漏（原本週五、週六永遠沒講）、
 * 也不重複（講兩次的那天，數字會被讀的人加兩遍）。下面的整年模擬就是在驗這件事。
 */
import { describe, expect, it } from 'vitest'
import {
  DIGEST_COVER_MAX_DAYS,
  coverPhrase,
  coverTitle,
  digestCompareRange,
  digestCoverDays,
  isDigestDayOff,
  mondayOf,
  weeklyInsightMondays,
} from './digest-window'
import { addDays, daysBetween, isServiceDayOff, mdw, type ServiceHoursLike } from './time'

/** MYFEEL 的真實設定（舊資料沒有 holidayOff ＝ 跟週末一樣） */
const MYFEEL: ServiceHoursLike = { enabled: true, start: '10:00', end: '19:00', weekendOff: true }
const WEEKEND_ONLY: ServiceHoursLike = { ...MYFEEL, holidayOff: false }
const HOLIDAY_ONLY: ServiceHoursLike = { ...MYFEEL, weekendOff: false, holidayOff: true }
const OFF: ServiceHoursLike = { ...MYFEEL, enabled: false }

describe('digestCoverDays：這一則講哪幾天', () => {
  it('平常的週二 → 只有昨天', () => {
    expect(digestCoverDays(MYFEEL, '2026-10-20')).toEqual(['2026-10-19'])
  })

  it('週一 → 週五到週日（原本只講週日）', () => {
    expect(digestCoverDays(MYFEEL, '2026-10-19')).toEqual(['2026-10-16', '2026-10-17', '2026-10-18'])
  })

  it('中秋＋教師節連假回來（9/29 二）→ 9/24（四）到 9/28（一）5 天', () => {
    expect(digestCoverDays(MYFEEL, '2026-09-29'))
      .toEqual(['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'])
  })

  it('光復節連假回來（10/27 二）→ 10/23 到 10/26 4 天；國定假日照常上班的店 → 週一那天就講完週末', () => {
    expect(digestCoverDays(MYFEEL, '2026-10-27')).toEqual(['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'])
    expect(digestCoverDays(WEEKEND_ONLY, '2026-10-26')).toEqual(['2026-10-23', '2026-10-24', '2026-10-25'])
    expect(digestCoverDays(WEEKEND_ONLY, '2026-10-27')).toEqual(['2026-10-26'])
  })

  it('服務時間沒開 → 永遠只有昨天（週一也是）', () => {
    expect(digestCoverDays(OFF, '2026-10-19')).toEqual(['2026-10-18'])
    expect(digestCoverDays(null, '2026-10-19')).toEqual(['2026-10-18'])
  })

  it('今天自己是休假日（後台卡週六打開）→ 照樣只講昨天', () => {
    expect(digestCoverDays(MYFEEL, '2026-10-17')).toEqual(['2026-10-16'])
  })

  it('最長的連假（2027 春節 2/4～2/10）回來那天 → 從 2/3 講起，沒有撞到上限', () => {
    const days = digestCoverDays(MYFEEL, '2027-02-11')
    expect(days[0]).toBe('2027-02-03')
    expect(days).toHaveLength(8)
    expect(days.length).toBeLessThan(DIGEST_COVER_MAX_DAYS)
  })

  /**
   * 整年模擬：每個會傳摘要的日子各講一段，所有段落接起來要剛好蓋住每一天一次。
   * 三種帳號各跑一次（2026-01-02 ～ 2027-12-31，含春節 9 天與 2027 春節 7 天連假）。
   */
  for (const [name, sh] of [['週末＋國定假日都休', MYFEEL], ['只休週末', WEEKEND_ONLY], ['只休國定假日', HOLIDAY_ONLY], ['沒開服務時間', OFF]] as const) {
    it(`整年模擬（${name}）：每一天剛好被講一次`, () => {
      const seen = new Map<string, number>()
      let lastSendDay = ''
      for (let d = '2026-01-02'; d <= '2027-12-31'; d = addDays(d, 1)) {
        if (isServiceDayOff(sh, new Date(`${d}T12:00:00+08:00`))) continue
        for (const k of digestCoverDays(sh, d)) seen.set(k, (seen.get(k) ?? 0) + 1)
        lastSendDay = d
      }
      // 從第一則講的第一天，到最後一則講的最後一天（昨天）
      for (let d = '2026-01-02'; d < lastSendDay; d = addDays(d, 1)) {
        expect(seen.get(d) ?? 0, d).toBe(1)
      }
    })
  }
})

describe('講給人聽的日期', () => {
  it('LINE 那句的主詞', () => {
    expect(coverPhrase(['2026-10-16', '2026-10-17', '2026-10-18'])).toBe('10/16（五）到 10/18（日）這 3 天')
  })
  it('後台卡的標題', () => {
    expect(coverTitle('2026-10-16', '2026-10-18')).toBe('10/16（五）～10/18（日）3 天')
  })
  it('mdw', () => {
    expect(mdw('2026-10-26')).toBe('10/26（一）')
  })
})

describe('weeklyInsightMondays：本週顧客觀察哪天附、附哪幾週', () => {
  it('週一就是週一', () => {
    expect(mondayOf('2026-10-19')).toBe('2026-10-19')
    expect(mondayOf('2026-10-25')).toBe('2026-10-19')
    expect(weeklyInsightMondays(MYFEEL, '2026-10-19')).toEqual(['2026-10-19'])
  })

  it('平常的週二不附（週一附過了）', () => {
    expect(weeklyInsightMondays(MYFEEL, '2026-10-20')).toEqual([])
  })

  it('週一放假（10/26 光復節補假）→ 週二附、窗口照樣錨週一；週三不再附', () => {
    expect(weeklyInsightMondays(MYFEEL, '2026-10-27')).toEqual(['2026-10-26'])
    expect(weeklyInsightMondays(MYFEEL, '2026-10-28')).toEqual([])
    // 國定假日照常上班的店：週一照常附
    expect(weeklyInsightMondays(WEEKEND_ONLY, '2026-10-27')).toEqual([])
  })

  it('2027 春節週一到週三都放（2/8～2/10）→ 週四附', () => {
    expect(weeklyInsightMondays(MYFEEL, '2027-02-11')).toEqual(['2027-02-08'])
  })

  it('2026 春節整週放（2/16～2/20）→ 那週一則都沒傳，下週一兩週一起附（原本那週整份沒了）', () => {
    expect(weeklyInsightMondays(MYFEEL, '2026-02-23')).toEqual(['2026-02-16', '2026-02-23'])
  })

  it('沒開服務時間 → 只有週一', () => {
    expect(weeklyInsightMondays(OFF, '2026-10-27')).toEqual([])
    expect(weeklyInsightMondays(OFF, '2026-10-26')).toEqual(['2026-10-26'])
  })

  /** 整年模擬：每個週一都剛好被某一則附到一次（漏＝那週沒了、重複＝同一週講兩次） */
  for (const [name, sh] of [['週末＋國定假日都休', MYFEEL], ['只休週末', WEEKEND_ONLY], ['只休國定假日', HOLIDAY_ONLY], ['沒開服務時間', OFF]] as const) {
    it(`整年模擬（${name}）：每個週一剛好附一次`, () => {
      const seen = new Map<string, number>()
      let lastSendDay = ''
      for (let d = '2026-01-05'; d <= '2027-12-31'; d = addDays(d, 1)) {
        if (isDigestDayOff(sh, d)) continue
        for (const m of weeklyInsightMondays(sh, d)) seen.set(m, (seen.get(m) ?? 0) + 1)
        lastSendDay = d
      }
      for (let m = '2026-01-12'; m <= lastSendDay; m = addDays(m, 7)) {
        expect(seen.get(m) ?? 0, m).toBe(1)
      }
    })
  }
})

describe('digestCompareRange：後台卡「比較」那一格', () => {
  it('單日 → 前天', () => {
    expect(digestCompareRange('2026-10-20', '2026-10-20'))
      .toEqual({ startDate: '2026-10-19', endDate: '2026-10-19', label: '前天' })
  })

  it('週五～週日 → 上週五～週日', () => {
    expect(digestCompareRange('2026-10-16', '2026-10-18'))
      .toEqual({ startDate: '2026-10-09', endDate: '2026-10-11', label: '上週同期' })
  })

  it('2027 春節後 8 天（2/3～2/10）→ 退兩週，⛔ 只退 7 天會跟這段重疊在 2/3', () => {
    expect(digestCompareRange('2027-02-03', '2027-02-10'))
      .toEqual({ startDate: '2027-01-20', endDate: '2027-01-27', label: '兩週前同期' })
  })

  it('最長 14 天也不重疊、星期對得上', () => {
    for (let n = 2; n <= DIGEST_COVER_MAX_DAYS; n++) {
      const start = '2027-02-01'
      const end = addDays(start, n - 1)
      const r = digestCompareRange(start, end)
      expect(r.endDate < start, `${n} 天`).toBe(true)
      expect(daysBetween(r.startDate, start) % 7, `${n} 天`).toBe(0)
      expect(daysBetween(r.startDate, r.endDate) + 1, `${n} 天`).toBe(n)
    }
  })
})
