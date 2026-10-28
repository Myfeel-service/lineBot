import { describe, expect, it } from 'vitest'
import {
  describeOpenRateChange,
  pickPreviousSameAudience,
  sameBroadcastAudience,
  type PreviousOpenCandidate,
} from './broadcast-open-compare'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 4, 4) // 10/4 中午（台灣）

function cand(over: Partial<PreviousOpenCandidate> = {}): PreviousOpenCandidate {
  return {
    id: 'prev',
    name: '小滑手_開賣',
    status: 'completed',
    audienceSource: { type: 'tags', tagIds: ['t-slide'] },
    sentCount: 2187,
    opened: 786,
    completedMs: T0 - 5 * DAY,
    ...over,
  }
}
const current = { id: 'cur', audienceSource: { type: 'tags' as const, tagIds: ['t-slide'] }, completedMs: T0 }

describe('sameBroadcastAudience：「同一群人」', () => {
  it('同一組標籤、順序不同 → 同一群', () => {
    expect(sameBroadcastAudience({ type: 'tags', tagIds: ['a', 'b'] }, { type: 'tags', tagIds: ['b', 'a'] })).toBe(true)
  })
  it('標籤多一顆或換一顆 → 不同群', () => {
    expect(sameBroadcastAudience({ type: 'tags', tagIds: ['a'] }, { type: 'tags', tagIds: ['a', 'b'] })).toBe(false)
    expect(sameBroadcastAudience({ type: 'tags', tagIds: ['a'] }, { type: 'tags', tagIds: ['b'] })).toBe(false)
  })
  it('全部好友對全部好友 → 同一群；全部好友對標籤 → 不同群', () => {
    expect(sameBroadcastAudience({ type: 'all' }, { type: 'all' })).toBe(true)
    expect(sameBroadcastAudience({ type: 'all' }, { type: 'tags', tagIds: ['a'] })).toBe(false)
  })
  it('⛔ 匯入名單永遠不算同一群（每次都是另一份名單）', () => {
    expect(sameBroadcastAudience({ type: 'import' }, { type: 'import' })).toBe(false)
  })
  it('沒選標籤的標籤推播、缺資料 → 不算', () => {
    expect(sameBroadcastAudience({ type: 'tags', tagIds: [] }, { type: 'tags', tagIds: [] })).toBe(false)
    expect(sameBroadcastAudience(null, { type: 'all' })).toBe(false)
  })
})

describe('pickPreviousSameAudience：上一則發給同一群人的', () => {
  it('挑比這則早發完、同一群人裡最近的那一則，算出打開比例', () => {
    const got = pickPreviousSameAudience(current, [
      cand({ id: 'older', name: '更早的', completedMs: T0 - 20 * DAY, opened: 100, sentCount: 1000 }),
      cand(),
    ])
    expect(got).toEqual({ name: '小滑手_開賣', completedMs: T0 - 5 * DAY, opened: 786, sentCount: 2187, openRate: 0.3594 })
  })

  it('⛔ 最近那一則沒有打開數 → 不比，不往前拿更早的（畫面講的是「上一則」）', () => {
    const got = pickPreviousSameAudience(current, [
      cand({ id: 'older', completedMs: T0 - 20 * DAY, opened: 100 }),
      cand({ opened: null }),
    ])
    expect(got).toBeNull()
  })

  it('跳過：這則自己、比這則晚發完的、別群人、沒送出去的、送 0 人的', () => {
    const got = pickPreviousSameAudience(current, [
      cand({ id: 'cur' }),
      cand({ id: 'later', completedMs: T0 + DAY }),
      cand({ id: 'other', completedMs: T0 - DAY, audienceSource: { type: 'tags', tagIds: ['t-other'] } }),
      cand({ id: 'draft', completedMs: T0 - DAY, status: 'draft' }),
      cand({ id: 'cancelled', completedMs: T0 - DAY, status: 'cancelled' }),
      cand({ id: 'zero', completedMs: T0 - DAY, sentCount: 0 }),
      cand({ id: 'nodate', completedMs: null }),
    ])
    expect(got).toBeNull()
  })

  it('部分失敗（failed、但有送到人）也算一則', () => {
    expect(pickPreviousSameAudience(current, [cand({ status: 'failed' })])?.opened).toBe(786)
  })
})

describe('describeOpenRateChange：底下那一句', () => {
  const fmtRate = (r: number) => `${(r * 100).toFixed(2)}%`
  const fmtDate = () => '9/29'
  const prev = { name: '小滑手_開賣', completedMs: T0 - 5 * DAY, opened: 786, sentCount: 2187, openRate: 0.3594 }

  it('少了：講上一則的名字、日期、比例與少幾個百分點；發完超過 7 天不加附註', () => {
    const text = describeOpenRateChange({ prev, currentRate: 0.2152, currentCompletedMs: T0, nowMs: T0 + 8 * DAY, formatRate: fmtRate, formatDate: fmtDate })
    expect(text).toBe('上一則發給同一群人的「小滑手_開賣」（9/29）是 35.94%，這則少了 14 個百分點。')
  })

  it('多了／差不多', () => {
    const base = { prev, currentCompletedMs: T0, nowMs: T0 + 30 * DAY, formatRate: fmtRate, formatDate: fmtDate }
    expect(describeOpenRateChange({ ...base, currentRate: 0.40 })).toContain('這則多了 4 個百分點。')
    expect(describeOpenRateChange({ ...base, currentRate: 0.362 })).toContain('這則差不多。')
  })

  it('這則發完還不到 7 天 → 講打開的人還會再多（不然剛發完那天看起來一定掉很多）', () => {
    const text = describeOpenRateChange({ prev: { ...prev, completedMs: T0 - 10 * DAY }, currentRate: 0.2, currentCompletedMs: T0, nowMs: T0 + DAY, formatRate: fmtRate, formatDate: fmtDate })
    expect(text).toMatch(/這則發完還不到 7 天，打開的人還會再多一些。$/)
  })

  it('兩則都還不到 7 天 → 講兩則數字都還會變', () => {
    const text = describeOpenRateChange({ prev, currentRate: 0.2, currentCompletedMs: T0, nowMs: T0 + DAY, formatRate: fmtRate, formatDate: fmtDate })
    expect(text).toMatch(/兩則發完都還不到 7 天，數字還會再變。$/)
  })
})
