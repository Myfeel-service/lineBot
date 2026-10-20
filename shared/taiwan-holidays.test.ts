/**
 * 國定放假日表（`D-137`②）。守的是「表本身沒寫壞」與「表快用完會喊」——
 * 表用完了不會有任何錯誤訊息，只會**安靜地把國定假日當成上班日**（客人收到「將盡快回覆您」、
 * 摘要放假照傳），就是這次要修的那個樣子。
 */
import { describe, expect, it } from 'vitest'
import { TAIWAN_HOLIDAYS, TAIWAN_HOLIDAYS_COVERED_UNTIL, nextTaiwanHoliday, taiwanHolidayName } from './taiwan-holidays'
import { daysBetween, taipeiDate } from './time'

describe('放假日表本身', () => {
  it('依日期排序、沒有重複（「下一個假日」靠順序）', () => {
    const dates = TAIWAN_HOLIDAYS.map(h => h.date)
    expect([...dates].sort()).toEqual(dates)
    expect(new Set(dates).size).toBe(dates.length)
  })

  it('每一天都是真的日期（2/30 這種打錯會被 Date 進位成 3/2）、都有名稱', () => {
    for (const h of TAIWAN_HOLIDAYS) {
      expect(new Date(`${h.date}T00:00:00Z`).toISOString().slice(0, 10), h.date).toBe(h.date)
      expect(h.name.trim(), h.date).not.toBe('')
    }
  })

  it('MYFEEL 實際休息的那幾天都在表上（9/25 中秋、9/28 教師節、10/9 國慶補假），10/26 光復節補假也在', () => {
    expect(taiwanHolidayName('2026-09-25')).toBe('中秋節')
    expect(taiwanHolidayName('2026-09-28')).toBe('教師節')
    expect(taiwanHolidayName('2026-10-09')).toBe('國慶日補假')
    expect(taiwanHolidayName('2026-10-26')).toBe('光復節補假')
    expect(taiwanHolidayName('2026-10-12')).toBeNull()
  })

  it('連假裡單純的週末不收（2026-10-11 週日）', () => {
    expect(taiwanHolidayName('2026-10-11')).toBeNull()
  })

  it('下一個假日：當天算、之後找最近的、表用完回 null', () => {
    expect(nextTaiwanHoliday('2026-10-26')?.date).toBe('2026-10-26')
    expect(nextTaiwanHoliday('2026-10-27')).toEqual({ date: '2026-12-25', name: '行憲紀念日' })
    expect(nextTaiwanHoliday('2028-01-01')).toBeNull()
  })

  it('週末本來就休的店：跳過落在週末的假日（10/25 週日光復節 → 講 10/26 補假）', () => {
    expect(nextTaiwanHoliday('2026-10-21')?.date).toBe('2026-10-25')
    expect(nextTaiwanHoliday('2026-10-21', { skipWeekends: true })).toEqual({ date: '2026-10-26', name: '光復節補假' })
  })

  it('涵蓋到的那天不早於表上最後一個假日', () => {
    expect(TAIWAN_HOLIDAYS_COVERED_UNTIL >= TAIWAN_HOLIDAYS[TAIWAN_HOLIDAYS.length - 1]!.date).toBe(true)
  })

  /**
   * 存量看門：刻意吃真實日期。行政院每年 5～6 月核定隔年的行事曆，
   * 這條在表尾前半年紅，剛好是查得到下一年的時候。
   */
  it('放假日表至少還有 6 個月的存量', () => {
    const runwayDays = daysBetween(taipeiDate(), TAIWAN_HOLIDAYS_COVERED_UNTIL)
    expect(
      runwayDays,
      `國定放假日表只到 ${TAIWAN_HOLIDAYS_COVERED_UNTIL} 了。請到 shared/taiwan-holidays.ts 補下一年`
      + '（每一天、含補假，查證兩個來源對得上再寫），並更新 TAIWAN_HOLIDAYS_COVERED_UNTIL。',
    ).toBeGreaterThan(180)
  })
})
