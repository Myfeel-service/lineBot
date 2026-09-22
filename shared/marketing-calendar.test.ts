import { describe, expect, it } from 'vitest'
import {
  buildActions,
  buildMarketingCalendar,
  buildReasons,
  calendarHeadline,
  CALENDAR_SOON_DAYS,
  CALENDAR_WINDOW_DAYS,
  emptyCalendarFacts,
  hasOwnReasons,
  seasonMatchesFestival,
  type CalendarFacts,
} from './marketing-calendar'
import { emptyStoreProfile, setStoreProfileField, type StoreProfileDoc } from './types/store-profile'
import { TAIWAN_FESTIVALS } from './taiwan-festivals'

const midAutumn = TAIWAN_FESTIVALS.find(f => f.name === '中秋節')!
const nationalDay = TAIWAN_FESTIVALS.find(f => f.name === '國慶日')!

function profileOf(over: Record<string, string> = {}): StoreProfileDoc {
  let p = emptyStoreProfile()
  const base: Record<string, string> = {
    industry: '零售／電商',
    products: '黑豆水、養生茶包、節慶禮盒',
    customers: '一般消費者',
    channel: '網購為主',
    season: '年節送禮（春節、中秋）',
    ...over,
  }
  for (const [k, v] of Object.entries(base)) if (v) p = setStoreProfileField(p, k as never, v, 'owner', 1)
  return p
}

function facts(over: Partial<CalendarFacts> = {}): CalendarFacts {
  return { ...emptyCalendarFacts(), ...over }
}

describe('seasonMatchesFestival', () => {
  it('送禮旺季對得上中秋、春節', () => {
    expect(seasonMatchesFestival(profileOf(), midAutumn)).toBe(true)
  })
  it('送禮旺季對不上國慶日', () => {
    expect(seasonMatchesFestival(profileOf(), nationalDay)).toBe(false)
  })
  it('沒填旺季一律不算對上（⛔ 不可以猜）', () => {
    expect(seasonMatchesFestival(profileOf({ season: '' }), midAutumn)).toBe(false)
    expect(seasonMatchesFestival(null, midAutumn)).toBe(false)
  })
  it('夏天旺季對得上端午', () => {
    const dragon = TAIWAN_FESTIVALS.find(f => f.name === '端午節')!
    expect(seasonMatchesFestival(profileOf({ season: '夏天' }), dragon)).toBe(true)
  })
})

describe('buildReasons', () => {
  it('⛔ 什麼數字都沒有時回空陣列（不可以編一句「這檔通常不錯」）', () => {
    expect(buildReasons(null, nationalDay, facts())).toEqual([])
    expect(buildReasons(profileOf(), nationalDay, facts())).toEqual([])
  })

  it('每一條都帶得出出處', () => {
    const r = buildReasons(profileOf(), midAutumn, facts({ friendCount: 300 }))
    expect(r.length).toBeGreaterThan(0)
    for (const x of r) expect(x.source.length, x.text).toBeGreaterThan(0)
  })

  it('旺季對上時，理由要指得回他自己填的答案', () => {
    const r = buildReasons(profileOf(), midAutumn, facts())
    expect(r[0]?.text).toContain('年節送禮')
    expect(r[0]?.source).toContain('你在')
  })

  it('標籤人數 0 的不當理由（等於沒人可發）', () => {
    const r = buildReasons(profileOf(), midAutumn, facts({ matchedTags: [{ name: '送禮客', memberCount: 0 }] }))
    expect(r.some(x => x.text.includes('送禮客'))).toBe(false)
  })

  it('⛔ 只有好友總數時不可以單獨當理由（它對每個節日都成立＝沒講）', () => {
    const r = buildReasons(profileOf({ season: '' }), nationalDay, facts({ friendCount: 300 }))
    expect(r).toEqual([])
  })

  it('已經有別的理由時，好友總數可以補在後面當規模參考', () => {
    const r = buildReasons(profileOf(), midAutumn, facts({ friendCount: 300 }))
    expect(r.some(x => x.text.includes('300'))).toBe(true)
  })

  it('去年發過推播是強理由，要講得出名字與人數', () => {
    const r = buildReasons(profileOf({ season: '' }), midAutumn, facts({ lastYearBroadcast: { name: '中秋禮盒預購', sentCount: 412 } }))
    expect(r[0]?.text).toContain('中秋禮盒預購')
    expect(r[0]?.text).toContain('412')
    expect(r[0]?.source).toBe('推播紀錄')
  })

  it('標籤最多列兩顆（再多就變字牆）', () => {
    const r = buildReasons(profileOf(), midAutumn, facts({
      matchedTags: [
        { name: 'A', memberCount: 1 }, { name: 'B', memberCount: 2 }, { name: 'C', memberCount: 3 },
      ],
    }))
    expect(r.filter(x => x.source === '標籤管理的實際人數')).toHaveLength(2)
  })
})

describe('buildActions', () => {
  it('固定三件事', () => {
    expect(buildActions(profileOf(), midAutumn, 30)).toHaveLength(3)
  })

  it('照剩幾天換第一件事（規劃 → 準備 → 最後確認）', () => {
    expect(buildActions(profileOf(), midAutumn, 30)[0]).toContain('決定')
    expect(buildActions(profileOf(), midAutumn, 7)[0]).toContain('排進排程')
    expect(buildActions(profileOf(), midAutumn, 1)[0]).toContain('最後確認')
  })

  it('預約制的店講時段，不講出貨', () => {
    const a = buildActions(profileOf({ channel: '預約制' }), midAutumn, 30)
    expect(a.join()).toContain('時段')
    expect(a.join()).not.toContain('出貨')
  })

  it('連假要講值班', () => {
    const longWeekend = TAIWAN_FESTIVALS.find(f => f.longWeekend)!
    expect(buildActions(profileOf(), longWeekend, 30).join()).toContain('值班')
  })

  it('⛔ 不承諾成效（不可以出現「可以多賣」這種我們算不出來的話）', () => {
    for (const d of [30, 7, 1]) {
      const a = buildActions(profileOf(), midAutumn, d).join()
      expect(a).not.toMatch(/多賣|成長|提升\s*\d|增加\s*\d|％|%/)
    }
  })
})

describe('buildMarketingCalendar', () => {
  const allFacts = () => facts()

  it('只列視窗內的，而且照日期排', () => {
    const list = buildMarketingCalendar('2026-09-23', profileOf(), allFacts)
    expect(list.length).toBeGreaterThan(0)
    for (const e of list) {
      expect(e.inDays).toBeGreaterThanOrEqual(0)
      expect(e.inDays).toBeLessThanOrEqual(CALENDAR_WINDOW_DAYS)
    }
    const days = list.map(e => e.inDays)
    expect([...days].sort((a, b) => a - b)).toEqual(days)
  })

  it('兩週內的標成「快到了」', () => {
    const list = buildMarketingCalendar('2026-09-23', profileOf(), allFacts)
    for (const e of list) expect(e.soon).toBe(e.inDays <= CALENDAR_SOON_DAYS)
  })

  it('每一檔都有通用切角與三件事（那兩樣永遠拿得到）', () => {
    for (const e of buildMarketingCalendar('2026-09-23', profileOf(), allFacts)) {
      expect(e.generalAngle.length).toBeGreaterThan(0)
      expect(e.actions).toHaveLength(3)
    }
  })

  it('沒有輪廓也生得出月曆（只是沒有「為什麼是你」）', () => {
    const list = buildMarketingCalendar('2026-09-23', null, allFacts)
    expect(list.length).toBeGreaterThan(0)
    for (const e of list) expect(hasOwnReasons(e)).toBe(false)
  })

  it('表尾用完之後回空清單，不炸', () => {
    expect(buildMarketingCalendar('2099-01-01', profileOf(), allFacts)).toEqual([])
  })
})

describe('calendarHeadline', () => {
  const list = buildMarketingCalendar('2026-09-23', profileOf(), () => facts())

  it('講得出幾個檔期、幾個快到了', () => {
    const h = calendarHeadline(list, true)
    expect(h).toContain(`${list.length} 個檔期`)
  })

  it('⛔ 沒有輪廓時一定要講「只有通用的建議」', () => {
    expect(calendarHeadline(list, false)).toContain('通用的建議')
    expect(calendarHeadline(list, true)).not.toContain('通用的建議')
  })

  it('沒有檔期時講得出「可以專心顧日常」，不是丟一個 0', () => {
    expect(calendarHeadline([], true)).toContain('沒有重要節日')
  })
})
