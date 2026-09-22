import { describe, expect, it } from 'vitest'
import {
  collectLearnings,
  formatProfileRefreshLines,
  learnCustomers,
  learnFaq,
  PROFILE_REFRESH_INTERVAL_DAYS,
  PROFILE_REFRESH_MAX,
  PROFILE_REFRESH_MIN_EVENTS,
  shouldAskProfileRefresh,
} from './profile-refresh'
import { emptyStoreProfile, setStoreProfileField, type StoreProfileDoc } from './types/store-profile'

const DAY = 86_400_000

function withFaq(value: string, source: 'owner' | 'ai' | 'conversation'): StoreProfileDoc {
  return setStoreProfileField(emptyStoreProfile(), 'faq', value, source, 1)
}

describe('shouldAskProfileRefresh', () => {
  it('從來沒提過 → 要提', () => {
    expect(shouldAskProfileRefresh(null, Date.now())).toBe(true)
    expect(shouldAskProfileRefresh(0, Date.now())).toBe(true)
  })
  it('⛔ 剛提過不要再提（每週問同一件事會被當雜訊）', () => {
    const now = Date.now()
    expect(shouldAskProfileRefresh(now - 7 * DAY, now)).toBe(false)
  })
  it('滿一個月才再提', () => {
    const now = Date.now()
    expect(shouldAskProfileRefresh(now - (PROFILE_REFRESH_INTERVAL_DAYS - 1) * DAY, now)).toBe(false)
    expect(shouldAskProfileRefresh(now - PROFILE_REFRESH_INTERVAL_DAYS * DAY, now)).toBe(true)
  })
})

describe('learnFaq', () => {
  const strong = [
    { topic: '保固怎麼算', eventCount: 12 },
    { topic: '可以貨到付款嗎', eventCount: 8 },
    { topic: '出貨要幾天', eventCount: 5 },
  ]

  it('學得到的時候帶得出新值與出處', () => {
    const l = learnFaq(emptyStoreProfile(), strong)!
    expect(l.field).toBe('faq')
    expect(l.value).toBe('保固怎麼算、可以貨到付款嗎、出貨要幾天')
    expect(l.evidence).toContain('25 次')
    expect(l.evidence).toContain('保固怎麼算')
  })

  it('⛔ 商家自己填過就不提（他填的比統計準，提了等於質疑他）', () => {
    expect(learnFaq(withFaq('出貨、退換貨', 'owner'), strong)).toBeNull()
  })

  it('AI 或對話填的可以更新（那本來就是猜的）', () => {
    expect(learnFaq(withFaq('舊的內容', 'ai'), strong)).not.toBeNull()
    expect(learnFaq(withFaq('舊的內容', 'conversation'), strong)).not.toBeNull()
  })

  it('⛔ 跟現在的值一樣就不提（那不是更新，是雜訊）', () => {
    const same = withFaq('保固怎麼算、可以貨到付款嗎、出貨要幾天', 'conversation')
    expect(learnFaq(same, strong)).toBeNull()
  })

  it('⛔ 問太少次的不算趨勢', () => {
    const weak = [{ topic: '有停車位嗎', eventCount: PROFILE_REFRESH_MIN_EVENTS - 1 }]
    expect(learnFaq(emptyStoreProfile(), weak)).toBeNull()
  })

  it('沒有候選就回 null，不硬擠', () => {
    expect(learnFaq(emptyStoreProfile(), [])).toBeNull()
  })

  it('空白主題不算數', () => {
    expect(learnFaq(emptyStoreProfile(), [{ topic: '   ', eventCount: 99 }])).toBeNull()
  })

  it('⛔ 取樣來的次數要講「至少」，不可以當精確值', () => {
    const l = learnFaq(emptyStoreProfile(), [{ topic: '保固', eventCount: 30, sampled: true }])!
    expect(l.evidence).toContain('至少')
    const exact = learnFaq(emptyStoreProfile(), [{ topic: '保固', eventCount: 30 }])!
    expect(exact.evidence).not.toContain('至少')
  })

  it('最多取三個主題', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ topic: `主題${i}`, eventCount: 20 - i }))
    expect(learnFaq(emptyStoreProfile(), many)!.value.split('、')).toHaveLength(3)
  })
})

describe('learnCustomers', () => {
  it('完全沒填過才提，而且帶得出人數', () => {
    const l = learnCustomers(emptyStoreProfile(), { name: '送禮客', addedThisMonth: 40 })!
    expect(l.field).toBe('customers')
    expect(l.evidence).toContain('40 位')
  })

  it('⛔ 已經有值就不動（不管是誰填的——這一條比 FAQ 弱得多）', () => {
    const p = setStoreProfileField(emptyStoreProfile(), 'customers', '一般消費者', 'ai', 1)
    expect(learnCustomers(p, { name: '送禮客', addedThisMonth: 40 })).toBeNull()
  })

  it('人數太少不提', () => {
    expect(learnCustomers(emptyStoreProfile(), { name: '送禮客', addedThisMonth: 1 })).toBeNull()
    expect(learnCustomers(emptyStoreProfile(), null)).toBeNull()
  })
})

describe('collectLearnings', () => {
  it('最多兩題', () => {
    const out = collectLearnings(
      emptyStoreProfile(),
      [{ topic: '保固', eventCount: 10 }],
      { name: '送禮客', addedThisMonth: 40 },
    )
    expect(out.length).toBeLessThanOrEqual(PROFILE_REFRESH_MAX)
  })

  it('什麼都學不到就回空陣列', () => {
    expect(collectLearnings(emptyStoreProfile(), [], null)).toEqual([])
  })

  it('強的（FAQ）排在前面', () => {
    const out = collectLearnings(emptyStoreProfile(), [{ topic: '保固', eventCount: 10 }], { name: '送禮客', addedThisMonth: 40 })
    expect(out[0]!.field).toBe('faq')
  })
})

describe('formatProfileRefreshLines', () => {
  it('⛔ 沒學到就整段不出現（不可以每個月硬擠一句）', () => {
    expect(formatProfileRefreshLines([])).toEqual([])
  })

  it('每一題都講得出新值與出處', () => {
    const lines = formatProfileRefreshLines([
      { field: 'faq', value: '保固、出貨', evidence: '這一個月客人問了 20 次' },
    ])
    expect(lines[0]).toContain('客人最常問的事')
    expect(lines[0]).toContain('保固、出貨')
    expect(lines[0]).toContain('20 次')
  })

  it('⛔ 最後一定要講「我還沒改」（不講他會以為系統自己改掉了）', () => {
    const lines = formatProfileRefreshLines([
      { field: 'faq', value: 'x', evidence: 'y' },
    ])
    expect(lines[lines.length - 1]).toContain('還沒改')
    expect(lines[lines.length - 1]).toContain('組織與 LINE')
  })
})
