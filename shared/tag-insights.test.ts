/**
 * 貼標分析聚合的測試（`D-63` 起家）。
 *
 * 這裡守的不是「函式會不會跑」，是**幾條會讓數字說謊的口徑**：
 *  ① `superseded` 要算成同意，`auto_applied` 不可以算進採用率
 *  ② 掃描截斷時「沒有標籤的人數」要回「算不出來」而不是一個錯的數字
 *
 * `D-155`（2026-10-28）拿掉了排行、來源占比、兩兩交集、事件 vs 意圖四支（新版好友統計不再用），
 * 它們的測試一起退場；新版的意圖與交集測試在 `friend-report.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateCoverage,
  aggregateSuggestionOutcomes,
  findTagHealthIssues,
  memberCountsFromRows,
  type UserTagRow,
} from './tag-insights'

const row = (userId: string, tagId: string, sourceType: UserTagRow['sourceType']): UserTagRow =>
  ({ userId, tagId, sourceType })

describe('memberCountsFromRows：每顆標籤幾位客人', () => {
  it('以人去重，不是數文件筆數', () => {
    const counts = memberCountsFromRows([
      row('u1', 't1', 'ai'),
      row('u1', 't1', 'manual'), // 同一個人同一顆（理論上不該有）→ 仍只算一位
      row('u2', 't1', 'ai'),
      row('u2', 't2', 'manual'),
    ])
    expect(counts).toEqual({ t1: 2, t2: 1 })
  })

  it('缺 userId 或 tagId 的髒資料直接不計，不要變成一顆叫 undefined 的標籤', () => {
    const counts = memberCountsFromRows([
      row('u1', 't1', 'ai'),
      { userId: '', tagId: 't1', sourceType: 'ai' },
      { userId: 'u2', tagId: '', sourceType: 'ai' },
    ])
    expect(counts).toEqual({ t1: 1 })
  })
})

describe('aggregateCoverage：幾位客人一顆標籤都沒有', () => {
  it('算得出來時給人數與百分比', () => {
    const r = aggregateCoverage([row('u1', 't1', 'ai'), row('u2', 't1', 'ai')], 10)
    expect(r).toEqual({ taggedUsers: 2, untaggedUsers: 8, totalUsers: 10, pct: 20 })
  })

  it('⛔ 掃描撞上限時一律回「算不出來」，不要給一個錯的人數', () => {
    const r = aggregateCoverage([row('u1', 't1', 'ai')], 10, { truncated: true })
    expect(r.untaggedUsers).toBeNull()
    expect(r.pct).toBeNull()
    expect(r.taggedUsers).toBe(1) // 掃到的部分仍是事實，照回
  })

  it('好友總數拿不到（查詢失敗）時也回 null，不要當成 0 位好友', () => {
    const r = aggregateCoverage([row('u1', 't1', 'ai')], null)
    expect(r.pct).toBeNull()
    expect(r.untaggedUsers).toBeNull()
  })

  it('兩次查詢之間名單變動導致貼標人數大於總數時，不回負數', () => {
    const r = aggregateCoverage([row('u1', 't1', 'ai'), row('u2', 't1', 'ai')], 1)
    expect(r.untaggedUsers).toBe(0)
    expect(r.pct).toBe(100)
  })
})

describe('aggregateSuggestionOutcomes：AI 貼標的成績', () => {
  it('⛔ 人自己去手動貼了同一顆（superseded）要算成同意，漏掉會低報準確率', () => {
    const r = aggregateSuggestionOutcomes([
      { event: 'applied' }, { event: 'applied' },
      { event: 'superseded' },
      { event: 'dismissed' },
    ])
    expect(r.agreed).toBe(3)
    expect(r.decided).toBe(4)
    expect(r.acceptanceRate).toBe(75)
  })

  it('⛔ AI 直接貼（auto_applied）不可以算進採用率，等於自動送 100% 分', () => {
    const r = aggregateSuggestionOutcomes([
      { event: 'auto_applied' }, { event: 'auto_applied' },
      { event: 'applied' }, { event: 'dismissed' },
    ])
    expect(r.autoApplied).toBe(2)
    expect(r.decided).toBe(2) // 只有 applied + dismissed
    expect(r.acceptanceRate).toBe(50)
  })

  it('⛔ 還在等人決定的（suggested）不該拉低分數', () => {
    const r = aggregateSuggestionOutcomes([
      { event: 'suggested' }, { event: 'suggested' }, { event: 'suggested' },
      { event: 'applied' },
    ])
    expect(r.suggested).toBe(3)
    expect(r.acceptanceRate).toBe(100)
  })

  it('還沒有人做過任何決定時回 null，不是 0（0 會被讀成「AI 全錯」）', () => {
    const r = aggregateSuggestionOutcomes([{ event: 'suggested' }])
    expect(r.acceptanceRate).toBeNull()
  })
})

describe('findTagHealthIssues：可操作的清理清單', () => {
  const tags = [
    { id: 'a', name: '有人用的', aiMode: 'suggest' },
    { id: 'b', name: '建了沒用', aiMode: 'off' },
    { id: 'c', name: 'AI 開著卻沒判出人', aiMode: 'auto' },
    { id: 'd', name: '已停用的', aiMode: 'suggest', status: 'inactive' },
  ]

  it('列出零人數與「AI 開著卻從來沒判出人」的標籤', () => {
    const out = findTagHealthIssues(tags, { a: 12, c: 3 }, new Set(['a']))
    expect(out.zeroMember.map(t => t.id)).toEqual(['b'])
    expect(out.aiOnButNeverProduced.map(t => t.id)).toEqual(['c'])
  })

  it('已停用的標籤不列（那是刻意收起來的，不是壞掉）', () => {
    const out = findTagHealthIssues(tags, {}, new Set())
    expect(out.zeroMember.map(t => t.id)).not.toContain('d')
    expect(out.aiOnButNeverProduced.map(t => t.id)).not.toContain('d')
  })

  it('沒有 aiMode 欄位的舊標籤＝off，不該被當成「AI 開著卻沒判出人」', () => {
    const out = findTagHealthIssues([{ id: 'old', name: '舊標籤' }], { old: 5 }, new Set())
    expect(out.aiOnButNeverProduced).toEqual([])
  })
})
