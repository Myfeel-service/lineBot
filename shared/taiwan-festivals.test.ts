/**
 * 節慶行銷提醒的判定與文案（2026-08-20）。
 *
 * 這裡釘住的是「什麼時候該講、講幾天、講哪一句」，不是實作細節：
 *  - 前 7／3／1 天各講一次，中間的日子不重複講
 *  - 商家休假日跳過的提醒，下一個上班日要補講，而且**天數要講真話**
 *  - 同一天兩個節日到期 → 只講最近的，另一個明天再講（不可以整個消失）
 *  - 節日當天與過期不再講
 *  - 三個里程碑講的是**不同的事**（否則就是三倍雜訊）
 *
 * 另有一條「節日表存量」看門測試：表快用完時會紅，提醒補下一年的日期。
 */
import { describe, it, expect } from 'vitest'
import {
  FESTIVAL_REMIND_DAYS,
  TAIWAN_FESTIVALS,
  festivalCoverageEnd,
  festivalReminderText,
  hasFestivalInWindow,
  pickFestivalReminder,
} from './taiwan-festivals'
import { addDays, daysBetween, taipeiDate } from './time'

/** 中秋 2026-09-25：拿來當主要情境（真連假、真送禮檔期，附近沒有別的節日干擾） */
const MIDAUTUMN = '2026-09-25'

function textOn(today: string, sent: Record<string, number> = {}) {
  const r = pickFestivalReminder(today, sent)
  return r ? festivalReminderText(r) : null
}

describe('節日表本身', () => {
  it('依日期排序（插錯位置會讓「最近的節日」挑錯）', () => {
    const dates = TAIWAN_FESTIVALS.map(f => f.date)
    expect([...dates].sort()).toEqual(dates)
  })

  it('id 不重複，而且不含「.」（會被 Firestore 當成巢狀欄位路徑）', () => {
    const ids = TAIWAN_FESTIVALS.map(f => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter(id => id.includes('.'))).toEqual([])
  })

  it('每一條都有日期格式正確的日期、名稱與行銷角度', () => {
    for (const f of TAIWAN_FESTIVALS) {
      expect(f.date, f.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(f.name.length, f.id).toBeGreaterThan(0)
      expect(f.angle.length, f.id).toBeGreaterThan(0)
    }
  })

  it('查證過的關鍵農曆節日日期沒被改掉', () => {
    const byId = new Map(TAIWAN_FESTIVALS.map(f => [f.id, f.date]))
    // 2026／2027 皆經兩處獨立來源對照（查證日 2026-08-20）
    expect(byId.get('midautumn-2026')).toBe('2026-09-25')
    expect(byId.get('lunarnewyear-2027')).toBe('2027-02-06')
    expect(byId.get('dragonboat-2027')).toBe('2027-06-09')
    expect(byId.get('midautumn-2027')).toBe('2027-09-15')
  })

  /**
   * 存量看門：表用完了就會**安靜地再也不提醒**，沒有任何錯誤訊息。
   * 這條刻意吃真實日期，就是要在還來得及的時候紅一次。
   */
  it('節日表至少還有 6 個月的存量', () => {
    const runwayDays = daysBetween(taipeiDate(), festivalCoverageEnd())
    expect(
      runwayDays,
      `節日表只到 ${festivalCoverageEnd()} 了。請到 shared/taiwan-festivals.ts 補下一年的節日`
      + '（農曆節日與母親節逐年不同，一律查證兩個獨立來源對得上再寫）。',
    ).toBeGreaterThan(180)
  })
})

describe('什麼時候該講', () => {
  it('前 7 天講第一次', () => {
    const r = pickFestivalReminder(addDays(MIDAUTUMN, -7))
    expect(r).toMatchObject({ milestone: 7, daysUntil: 7 })
    expect(r!.festival.id).toBe('midautumn-2026')
  })

  it('講過 7 天那次以後，第 6、5、4 天都不再講', () => {
    const sent = { 'midautumn-2026': 7 }
    for (const d of [-6, -5, -4]) {
      expect(textOn(addDays(MIDAUTUMN, d), sent), `剩 ${-d} 天`).toBeNull()
    }
  })

  it('前 3 天、前 1 天各再講一次', () => {
    const three = pickFestivalReminder(addDays(MIDAUTUMN, -3), { 'midautumn-2026': 7 })
    expect(three).toMatchObject({ milestone: 3, daysUntil: 3 })

    const one = pickFestivalReminder(addDays(MIDAUTUMN, -1), { 'midautumn-2026': 3 })
    expect(one).toMatchObject({ milestone: 1, daysUntil: 1 })
  })

  it('節日當天與過完都不再講', () => {
    const sent = { 'midautumn-2026': 1 }
    expect(textOn(MIDAUTUMN, sent)).toBeNull()
    expect(textOn(addDays(MIDAUTUMN, 1), sent)).toBeNull()
    // 連一次都沒講過也一樣：節日已經過了就沒有行銷價值
    expect(textOn(addDays(MIDAUTUMN, 1))).toBeNull()
  })

  it('太遠（8 天以上）不講', () => {
    expect(textOn(addDays(MIDAUTUMN, -8))).toBeNull()
    expect(hasFestivalInWindow(addDays(MIDAUTUMN, -8))).toBe(false)
    expect(hasFestivalInWindow(addDays(MIDAUTUMN, -7))).toBe(true)
  })
})

describe('商家休假日跳過 → 上班日補講', () => {
  it('週末跳過兩天，第 5 天補講，而且天數講真話', () => {
    // 前 7 天那天剛好是休假日 → 那輪整個沒發；下一個上班日剩 5 天
    const text = textOn(addDays(MIDAUTUMN, -5))
    expect(text).toContain('再過 5 天')
    expect(text).toContain('中秋節')
    // ⛔ 不可以講成「再過 7 天」——那是騙人的
    expect(text).not.toContain('再過 7 天')
  })

  it('補講用的是 7 天那一段的語氣（還來得及規劃）', () => {
    expect(pickFestivalReminder(addDays(MIDAUTUMN, -5))).toMatchObject({ milestone: 7, daysUntil: 5 })
  })

  it('節日表把日期往後挪 → 已經講到「明天」的節日不會從頭再講一輪', () => {
    // 已記到里程碑 1（講過「明天就是」），若日期被改成 7 天後，不可以又從「還有 7 天」開始
    expect(textOn(addDays(MIDAUTUMN, -7), { 'midautumn-2026': 1 })).toBeNull()
    expect(textOn(addDays(MIDAUTUMN, -3), { 'midautumn-2026': 1 })).toBeNull()
  })

  it('連休好幾天跨過兩個里程碑 → 只講最緊迫的那一段，不補一串', () => {
    // 剩 2 天才開機：7 與 3 都已到期，只講 3 那段
    const r = pickFestivalReminder(addDays(MIDAUTUMN, -2))
    expect(r).toMatchObject({ milestone: 3, daysUntil: 2 })
    // 而且記成 3 之後就不會再回頭講 7
    expect(textOn(addDays(MIDAUTUMN, -2), { 'midautumn-2026': 3 })).toBeNull()
  })
})

describe('同一天兩個節日', () => {
  // 2027 重陽 10/08、國慶 10/10：10/07 兩個都到期
  it('只講最近的那一個', () => {
    const r = pickFestivalReminder('2027-10-07')
    expect(r!.festival.id).toBe('doubleninth-2027')
    expect(r).toMatchObject({ milestone: 1, daysUntil: 1 })
  })

  it('被讓開的那個不會消失，隔天輪到它', () => {
    const r = pickFestivalReminder('2027-10-08', { 'doubleninth-2027': 1 })
    expect(r!.festival.id).toBe('nationalday-2027')
    expect(festivalReminderText(r!)).toContain('再過 2 天')
  })
})

describe('三個里程碑講不同的事', () => {
  const at = (offset: number, sent: Record<string, number> = {}) =>
    festivalReminderText(pickFestivalReminder(addDays(MIDAUTUMN, offset), sent)!)

  it('7 天前：講備素材、想優惠，並附上日期', () => {
    const t = at(-7)
    expect(t).toContain('再過 7 天就是中秋節（09/25）')
    expect(t).toContain('禮盒與送禮的需求會明顯升溫')
    expect(t).toContain('素材')
  })

  it('3 天前：叫他現在就去排推播', () => {
    const t = at(-3, { 'midautumn-2026': 7 })
    expect(t).toContain('推播')
    expect(t).toContain('出貨')
  })

  it('前一天：講「明天」與最後確認清單', () => {
    const t = at(-1, { 'midautumn-2026': 3 })
    expect(t).toContain('明天就是中秋節')
    expect(t).toContain('最後確認')
    // 中秋是連假 → 提醒排值班
    expect(t).toContain('值班')
  })

  it('三段文字互不相同（否則就是同一句講三次）', () => {
    const texts = [at(-7), at(-3, { 'midautumn-2026': 7 }), at(-1, { 'midautumn-2026': 3 })]
    expect(new Set(texts).size).toBe(3)
  })

  it('不是連假的節日，前一天改講顧線上客服', () => {
    // 萬聖節 2026-10-31 沒有 longWeekend
    const r = pickFestivalReminder('2026-10-30', { 'halloween-2026': 3 })
    const t = festivalReminderText(r!)
    expect(r!.festival.id).toBe('halloween-2026')
    expect(t).toContain('顧線上客服')
    expect(t).not.toContain('值班')
  })
})

describe('里程碑常數', () => {
  it('由遠到近排列（判定取 min，順序錯了語氣會亂）', () => {
    expect([...FESTIVAL_REMIND_DAYS]).toEqual([7, 3, 1])
  })
})
