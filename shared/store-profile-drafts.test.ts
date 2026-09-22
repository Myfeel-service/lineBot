import { describe, expect, it } from 'vitest'
import {
  buildCalendarDraft,
  buildStoreDrafts,
  buildTagDrafts,
  buildToneDraft,
  buildWelcomeDraft,
  canBuildDrafts,
  splitProducts,
  STORE_DRAFT_KIND,
  summarizeDraftApply,
  type DraftApplyStep,
  type DraftContext,
} from './store-profile-drafts'
import { emptyStoreProfile, setStoreProfileField, type StoreProfileDoc } from './types/store-profile'

function profileOf(over: Partial<Record<string, string>> = {}): StoreProfileDoc {
  let p = emptyStoreProfile()
  const base: Record<string, string> = {
    industry: '零售／電商',
    products: '黑豆水、養生茶包、節慶禮盒',
    customers: '一般消費者',
    channel: '網購為主',
    season: '年節送禮（春節、中秋）',
    pain: '加好友後沒人理',
    ...over,
  }
  for (const [k, v] of Object.entries(base)) {
    if (v) p = setStoreProfileField(p, k as never, v, 'owner', 1)
  }
  return p
}

function ctxOf(over: Partial<DraftContext> = {}): DraftContext {
  return { shopName: '山丘咖啡', profile: profileOf(), today: '2026-09-22', ...over }
}

describe('splitProducts', () => {
  it('頓號、全形逗號、半形逗號、斜線都收', () => {
    expect(splitProducts('A、B，C,D/E')).toEqual(['A', 'B', 'C'])
  })
  it('最多三樣', () => {
    expect(splitProducts('A、B、C、D、E')).toHaveLength(3)
  })
  it('空的回空陣列，不炸', () => {
    expect(splitProducts('')).toEqual([])
    expect(splitProducts(undefined as never)).toEqual([])
  })
})

describe('加好友歡迎訊息', () => {
  it('帶得到店名與商品', () => {
    const t = buildWelcomeDraft(ctxOf())
    expect(t).toContain('山丘咖啡')
    expect(t).toContain('黑豆水')
  })

  it('⛔ 不可以插「客人的名字」變數（取不到會變成空白，而這是第一句話）', () => {
    expect(buildWelcomeDraft(ctxOf())).not.toContain('{{')
  })

  it('預約制的店問的是時段，不是出貨', () => {
    const t = buildWelcomeDraft(ctxOf({ profile: profileOf({ channel: '預約制' }) }))
    expect(t).toContain('預約')
    expect(t).not.toContain('出貨')
  })

  it('只有實體店的不要叫人問出貨', () => {
    const t = buildWelcomeDraft(ctxOf({ profile: profileOf({ channel: '實體店面' }) }))
    expect(t).toContain('營業時間')
  })

  it('沒填商品也讀得通，不會出現半句話', () => {
    const t = buildWelcomeDraft(ctxOf({ profile: profileOf({ products: '' }) }))
    expect(t).toContain('山丘咖啡')
    expect(t).not.toContain('我們主要做。')
  })

  it('連店名都沒有時退成「我們」，不會出現空白開頭', () => {
    const t = buildWelcomeDraft(ctxOf({ shopName: '   ' }))
    expect(t).toContain('歡迎加入我們')
  })
})

describe('AI 語氣', () => {
  it('⛔ 一定要保留安全規則（整包覆蓋 systemPrompt，只寫語氣等於把紅線刪掉）', () => {
    const t = buildToneDraft(ctxOf())
    expect(t).toContain('只能根據提供的「知識卡內容」回答')
    expect(t).toContain('不要自己編')
    expect(t).toContain('退費、法律糾紛、醫療診斷')
  })

  it('帶得到產業、商品與客群', () => {
    const t = buildToneDraft(ctxOf())
    expect(t).toContain('零售／電商')
    expect(t).toContain('黑豆水')
    expect(t).toContain('一般消費者')
  })

  it('AI 猜到語氣時用它，沒有就用預設的一句', () => {
    const withTone = buildToneDraft(ctxOf({ profile: setStoreProfileField(profileOf(), 'tone', '親切、講健康但不誇大', 'ai', 1) }))
    expect(withTone).toContain('親切、講健康但不誇大')
    expect(buildToneDraft(ctxOf())).toContain('親切、口語、不誇大')
  })

  it('輪廓幾乎全空也生得出合法的一段（不會出現連續標點）', () => {
    const t = buildToneDraft(ctxOf({ profile: emptyStoreProfile() }))
    expect(t).toContain('你是這家店的客服助理')
    expect(t).not.toMatch(/，。|、。|。。/)
  })
})

describe('建議標籤', () => {
  it('固定三顆', () => {
    expect(buildTagDrafts(ctxOf())).toHaveLength(3)
  })

  it('每顆都講得出「之後拿來做什麼」', () => {
    for (const t of buildTagDrafts(ctxOf())) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.why.length).toBeGreaterThan(5)
    }
  })

  it('送禮旺季的店給「送禮客」，其他店給「問過還沒買」', () => {
    const gift = buildTagDrafts(ctxOf()).map(t => t.name)
    expect(gift).toContain('送禮客')
    const summer = buildTagDrafts(ctxOf({ profile: profileOf({ season: '夏天' }) })).map(t => t.name)
    expect(summer).toContain('問過還沒買')
    expect(summer).not.toContain('送禮客')
  })

  it('預約制的店給「預約過」而不是「問過出貨」', () => {
    const names = buildTagDrafts(ctxOf({ profile: profileOf({ channel: '預約制' }) })).map(t => t.name)
    expect(names).toContain('預約過')
    expect(names).not.toContain('問過出貨')
  })

  it('名字不重複', () => {
    const names = buildTagDrafts(ctxOf()).map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('行銷月曆', () => {
  it('只列視窗內的節日，而且照日期排', () => {
    const list = buildCalendarDraft(ctxOf({ today: '2026-09-22' }))
    expect(list.length).toBeGreaterThan(0)
    for (const c of list) {
      expect(c.inDays).toBeGreaterThanOrEqual(0)
      expect(c.inDays).toBeLessThanOrEqual(90)
    }
    const days = list.map(c => c.inDays)
    expect([...days].sort((a, b) => a - b)).toEqual(days)
  })

  it('今天就是節日的那天也算在內（inDays = 0）', () => {
    const list = buildCalendarDraft(ctxOf({ today: '2026-09-25' }))
    expect(list[0]?.inDays).toBe(0)
    expect(list[0]?.name).toBe('中秋節')
  })

  it('⛔ 這一版只給通用 angle，不客製（客製是 C-223）', () => {
    const list = buildCalendarDraft(ctxOf())
    for (const c of list) {
      expect(c.angle).not.toContain('黑豆水')
      expect(c.angle.length).toBeGreaterThan(0)
    }
  })

  it('表尾用完之後不會炸，只是回空清單', () => {
    expect(buildCalendarDraft(ctxOf({ today: '2099-01-01' }))).toEqual([])
  })
})

describe('buildStoreDrafts', () => {
  it('沒讀到網站就不給「知識庫初稿」（給一張 0 張卡的卡片比不給還糟）', () => {
    const keys = buildStoreDrafts(ctxOf()).map(d => d.key)
    expect(keys).not.toContain('knowledge')
    const withSite = buildStoreDrafts(ctxOf({ pagesRead: 5 })).map(d => d.key)
    expect(withSite).toContain('knowledge')
  })

  it('月曆是「告訴你已經有了」，不是要你採用', () => {
    const cal = buildStoreDrafts(ctxOf()).find(d => d.key === 'calendar')!
    expect(cal.kind).toBe('info')
    expect(STORE_DRAFT_KIND.calendar).toBe('info')
    expect(cal.note).toContain('不用採用')
  })

  it('歡迎訊息一定要講「去 LINE 後台關掉內建那則」，而且不可以說已經幫你關了', () => {
    const w = buildStoreDrafts(ctxOf()).find(d => d.key === 'welcome')!
    expect(w.note).toContain('關掉')
    expect(w.note).toContain('讀不到那個開關')
    expect(w.note).not.toContain('已為你關閉')
  })

  it('每一樣都說得出東西會出現在後台哪裡', () => {
    for (const d of buildStoreDrafts(ctxOf({ pagesRead: 3 }))) {
      expect(d.where.length, d.key).toBeGreaterThan(0)
      expect(d.body.length, d.key).toBeGreaterThan(0)
    }
  })
})

describe('canBuildDrafts', () => {
  it('輪廓全空時不要生（生出來會是一堆空洞的句子）', () => {
    expect(canBuildDrafts(null)).toBe(false)
    expect(canBuildDrafts(emptyStoreProfile())).toBe(false)
  })
  it('答過任何一題就可以生', () => {
    expect(canBuildDrafts(setStoreProfileField(emptyStoreProfile(), 'industry', '餐飲', 'owner', 1))).toBe(true)
  })
  it('只有 AI 猜到的非問答欄位不算（那些長不出文案）', () => {
    expect(canBuildDrafts(setStoreProfileField(emptyStoreProfile(), 'rivals', '某某', 'ai', 1))).toBe(false)
  })
})

describe('summarizeDraftApply', () => {
  const step = (key: string, status: string, error?: string): DraftApplyStep =>
    ({ key: key as never, label: `建立${key}`, status: status as never, ...(error ? { error } : {}) })

  it('全部成功：不要用嚇人的標題', () => {
    const r = summarizeDraftApply([step('welcome', 'done'), step('tone', 'done')])
    expect(r.ok).toBe(true)
    expect(r.headline).not.toContain('失敗')
    expect(r.leftovers).toEqual([])
  })

  it('⛔ 有東西成了、有東西沒成：標題不可以用「失敗」，而且要點名已經建好的', () => {
    const r = summarizeDraftApply([step('welcome', 'done'), step('tags', 'failed', '撞名')])
    expect(r.ok).toBe(true)
    expect(r.headline).not.toContain('失敗')
    expect(r.headline).toContain('1 樣沒成')
    expect(r.leftovers.join()).toContain('建立welcome已經建好了')
  })

  it('一樣都沒成：要講「系統裡沒有留下東西，可以直接再試」', () => {
    const r = summarizeDraftApply([step('welcome', 'failed', 'x'), step('tone', 'failed', 'y')])
    expect(r.ok).toBe(false)
    expect(r.headline).toContain('沒有留下')
    expect(r.leftovers).toEqual([])
  })

  it('「先不要」跟「沒有執行」講的不是同一句', () => {
    const r = summarizeDraftApply([step('welcome', 'declined'), step('tone', 'skipped')])
    expect(r.lines[0]).toContain('先不要')
    expect(r.lines[1]).toContain('沒有執行')
    expect(r.lines[0]).not.toBe(r.lines[1])
  })

  it('全部被「先不要」時不算失敗，也不要留下殘骸清單', () => {
    const r = summarizeDraftApply([step('welcome', 'declined'), step('tone', 'declined')])
    expect(r.ok).toBe(false)
    expect(r.headline).toContain('沒有要建')
    expect(r.leftovers).toEqual([])
  })

  it('失敗時逐行講得出原因', () => {
    const r = summarizeDraftApply([step('tags', 'failed', '這個名稱跟現有標籤撞在一起')])
    expect(r.lines[0]).toContain('這個名稱跟現有標籤撞在一起')
  })
})
