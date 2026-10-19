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
  pickPlanned,
  plannedForFestival,
  plannedStatusText,
  seasonMatchesFestival,
  type CalendarBroadcastRow,
  type CalendarFacts,
  type PlannedBroadcast,
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

  it('去年這一檔發過推播是強理由，要講得出名字與人數', () => {
    const r = buildReasons(profileOf({ season: '' }), midAutumn, facts({ lastYearBroadcast: { name: '中秋禮盒預購', sentCount: 412 } }))
    expect(r[0]?.text).toBe('去年這一檔你發過「中秋禮盒預購」，送到 412 人')
    expect(r[0]?.source).toBe('推播紀錄')
  })

  it('`D-121`：去年那則有 LINE 的點連結人數就一起講，出處也要講到 LINE', () => {
    const r = buildReasons(profileOf({ season: '' }), midAutumn, facts({ lastYearBroadcast: { name: '中秋禮盒預購', sentCount: 2187, clicked: 443 } }))
    expect(r[0]?.text).toBe('去年這一檔你發過「中秋禮盒預購」，送到 2,187 人，443 人點連結')
    expect(r[0]?.source).toContain('LINE 官方統計')
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

describe('buildActions（`D-121`③：只留跟時間有關的那一句）', () => {
  const plain = TAIWAN_FESTIVALS.find(f => !f.longWeekend)!
  const longWeekend = TAIWAN_FESTIVALS.find(f => f.longWeekend)!

  it('⛔ 還早的檔期沒有「做什麼」（以前五檔都塞同樣三件事＝沒人讀）', () => {
    expect(buildActions(profileOf(), plain, 30)).toEqual([])
    expect(buildActions(profileOf(), plain, 7)).toEqual([])
  })

  it('⛔ 不再出現跟按鈕重複、或每檔都一樣的那幾句', () => {
    for (const d of [30, 7, 1]) {
      const a = buildActions(profileOf(), longWeekend, d).join()
      for (const bad of ['先決定', '準備好，排進排程', '想好這一檔的出貨時間', '當天安排人顧線上客服']) expect(a).not.toContain(bad)
    }
  })

  it('3 天內講「最後確認」', () => {
    expect(buildActions(profileOf(), plain, 3)).toEqual(['最後確認推播排了沒、庫存和出貨來不來得及'])
  })

  it('預約制的店最後確認講時段，不講出貨', () => {
    const a = buildActions(profileOf({ channel: '預約制' }), plain, 1).join()
    expect(a).toContain('時段')
    expect(a).not.toContain('出貨')
  })

  it('連假在兩週內才講值班（82 天後的元旦現在講值班太早）', () => {
    expect(buildActions(profileOf(), longWeekend, 10)).toEqual(['連假期間客服值班先排好'])
    expect(buildActions(profileOf(), longWeekend, 30)).toEqual([])
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

  it('每一檔都有通用切角（那一句永遠拿得到），「做什麼」最多兩句', () => {
    for (const e of buildMarketingCalendar('2026-09-23', profileOf(), allFacts)) {
      expect(e.generalAngle.length).toBeGreaterThan(0)
      expect(e.actions.length).toBeLessThanOrEqual(2)
    }
  })

  it('已經排好的推播帶得進每一檔；沒給就是空陣列', () => {
    const p = { id: 'b1', name: '中秋禮盒', status: 'scheduled' as const, atMs: 0 }
    const list = buildMarketingCalendar('2026-09-01', profileOf(), allFacts, undefined, f => (f.id === midAutumn.id ? [p] : []))
    expect(list.find(e => e.festivalId === midAutumn.id)?.planned).toEqual([p])
    expect(list.find(e => e.festivalId !== midAutumn.id)?.planned).toEqual([])
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
  it('`D-121`：只講範圍。⛔ 「還不認識你的店」交給卡片裡那一列講一次，標題不再重講', () => {
    expect(calendarHeadline()).toBe('未來 90 天')
    expect(calendarHeadline()).not.toContain('通用')
  })
})

describe('pickPlanned／plannedStatusText（已經為這一檔建好的推播）', () => {
  const p = (status: PlannedBroadcast['status'], atMs: number | null = null, id: string = status): PlannedBroadcast => ({ id, name: id, status, atMs })

  it('好幾則時先講排好的，再來發送中、發完的、草稿、失敗的', () => {
    expect(pickPlanned([p('draft'), p('failed'), p('scheduled', 2)])?.status).toBe('scheduled')
    expect(pickPlanned([p('draft'), p('completed', 1)])?.status).toBe('completed')
    expect(pickPlanned([])).toBeNull()
  })

  it('同一種狀態先講時間近的', () => {
    expect(pickPlanned([p('scheduled', 200, 'late'), p('scheduled', 100, 'early')])?.id).toBe('early')
  })

  it('時間一律講台灣時間', () => {
    // 2026-11-09 12:00 UTC＝台灣 20:00
    expect(plannedStatusText(p('scheduled', Date.UTC(2026, 10, 9, 12)))).toBe('已排程 11/09 20:00')
    expect(plannedStatusText(p('completed', Date.UTC(2026, 9, 7, 17)))).toBe('已發送 10/08')
    expect(plannedStatusText(p('draft'))).toBe('草稿，還沒排程')
    expect(plannedStatusText(p('failed'))).toBe('發送失敗')
  })
})

describe('自己的檔期進月曆（D-122②）', () => {
  const own = (id: string, date: string, name: string) => ({ id, date, name, angle: '', own: true })

  it('跟節日排在一起、照日期；帶 own 記號、沒有通用切角', () => {
    const list = buildMarketingCalendar('2026-10-11', profileOf(), () => facts(), undefined, () => [], [
      own('own-launch0001', '2026-11-20', '新品開賣'),
      own('own-anniv00001', '2026-10-24', '週年慶'),
    ])
    expect(list.map(e => e.name)).toEqual(['重陽節', '週年慶', '萬聖節', '雙 11 購物節', '新品開賣', '聖誕節', '元旦（跨年）'])
    const anniv = list.find(e => e.festivalId === 'own-anniv00001')!
    expect(anniv).toMatchObject({ own: true, generalAngle: '', inDays: 13, soon: true })
    // 節日那幾檔不帶 own（卡片靠它決定給「這次不做」還是「修改／刪除」）
    expect(list.find(e => e.name === '重陽節')).not.toHaveProperty('own')
  })

  it('同一天：自己的排前面（跟早上的提醒同一個先後）', () => {
    const list = buildMarketingCalendar('2026-10-11', profileOf(), () => facts(), undefined, () => [], [own('own-same000001', '2026-10-31', '萬聖派對')])
    const i = list.findIndex(e => e.name === '萬聖派對')
    expect(list[i + 1]?.name).toBe('萬聖節')
  })

  it('視窗外的自己的檔期不列（只收 90 天內，這裡是保險）', () => {
    const list = buildMarketingCalendar('2026-10-11', profileOf(), () => facts(), undefined, () => [], [own('own-far0000001', '2027-03-01', '春季新品')])
    expect(list.some(e => e.name === '春季新品')).toBe(false)
  })
})

describe('plannedForFestival：卡片與早上的 LINE 提醒共用（D-122①）', () => {
  const row = (over: Partial<CalendarBroadcastRow> = {}): CalendarBroadcastRow =>
    ({ id: 'b1', name: '重陽敬老早鳥', status: 'scheduled', atMs: 1, matchAtMs: Date.UTC(2026, 9, 16, 12), ...over })
  const ninth = TAIWAN_FESTIVALS.find(f => f.id === 'doubleninth-2026')!

  it('名稱有節日名、時間對得上的排程推播算這一檔；只回卡片要的四個欄位', () => {
    expect(plannedForFestival([row()], ninth)).toEqual([{ id: 'b1', name: '重陽敬老早鳥', status: 'scheduled', atMs: 1 }])
  })

  it('綁在這一檔的（設成檔期／從這裡擬的）算；綁在別檔的不算', () => {
    const own = { id: 'own-anniv00001', name: '週年慶', date: '2026-10-24', own: true }
    expect(plannedForFestival([row({ name: '早鳥', festivalId: own.id })], own)).toHaveLength(1)
    expect(plannedForFestival([row({ festivalId: 'halloween-2026' })], ninth)).toEqual([])
  })
})
