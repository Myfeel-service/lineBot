/**
 * 貼標分析聚合的測試（`D-63`）。
 *
 * 這裡守的不是「函式會不會跑」，是**幾條會讓數字說謊的口徑**：
 *  ① 批次貼標不可以灌爆「客人自己表現的」排行（分不出批次與單人手動，只能靠來源界線擋）
 *  ② `superseded` 要算成同意，`auto_applied` 不可以算進採用率
 *  ③ 掃描截斷時「沒有標籤的人數」要回「算不出來」而不是一個錯的數字
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateCoverage,
  aggregateSourceMix,
  aggregateSuggestionOutcomes,
  findTagHealthIssues,
  memberCountsFromRows,
  splitEventVsIntent,
  rankCustomerExpressedTags,
  topTagIntersections,
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

describe('rankCustomerExpressedTags：只算客人自己表現出來的', () => {
  it('⛔ 自己批次貼 300 人不可以霸佔排行第一名', () => {
    // 批次貼標與單人手動在資料庫裡長得一模一樣（都是 manual），事後分不出來——
    // 所以擋不掉「批次」，只能整個 manual 都不算。這條測試就是釘住那個決定。
    const batch = Array.from({ length: 300 }, (_, i) => row(`u${i}`, 'batch_tag', 'manual'))
    const real = [
      row('a', 'ship_question', 'ai'),
      row('b', 'ship_question', 'ai'),
      row('c', 'ship_question', 'rule'),
    ]
    const ranked = rankCustomerExpressedTags([...batch, ...real])
    expect(ranked[0]).toEqual({ tagId: 'ship_question', users: 3 })
    expect(ranked.find(r => r.tagId === 'batch_tag')).toBeUndefined()
  })

  it('「沒互動」那顆系統標籤要排除掉，否則永遠佔第一名', () => {
    const inactive = Array.from({ length: 50 }, (_, i) => row(`u${i}`, 'sys_inactive', 'system'))
    const ranked = rankCustomerExpressedTags(
      [...inactive, row('a', 'interest', 'ai'), row('b', 'interest', 'ai')],
      { excludeTagIds: ['sys_inactive'] },
    )
    expect(ranked.map(r => r.tagId)).toEqual(['interest'])
  })

  it('同票數時順序固定，畫面不會每次重算都跳動', () => {
    const rows = [row('a', 'zzz', 'ai'), row('b', 'aaa', 'ai')]
    expect(rankCustomerExpressedTags(rows).map(r => r.tagId)).toEqual(['aaa', 'zzz'])
    expect(rankCustomerExpressedTags([...rows].reverse()).map(r => r.tagId)).toEqual(['aaa', 'zzz'])
  })

  it('limit 只截長度，不影響排序', () => {
    const rows = [
      row('a', 't1', 'ai'), row('b', 't1', 'ai'), row('c', 't1', 'ai'),
      row('a', 't2', 'ai'), row('b', 't2', 'ai'),
      row('a', 't3', 'ai'),
    ]
    expect(rankCustomerExpressedTags(rows, { limit: 2 })).toEqual([
      { tagId: 't1', users: 3 },
      { tagId: 't2', users: 2 },
    ])
  })
})

describe('aggregateSourceMix：多少是自動判出來的', () => {
  it('分成「客人自己表現的」與「我們自己圈的」兩邊', () => {
    const mix = aggregateSourceMix([
      row('a', 't1', 'ai'),
      row('b', 't1', 'rule'),
      row('c', 't1', 'system'),
      row('d', 't2', 'manual'),
      row('e', 't2', 'import'),
    ])
    expect(mix.total).toBe(5)
    expect(mix.customerExpressed).toBe(3)
    expect(mix.ourOwn).toBe(2)
    expect(mix.counts.ai).toBe(1)
  })

  it('未知來源不計進總數（別讓髒資料灌進百分比）', () => {
    const mix = aggregateSourceMix([
      row('a', 't1', 'ai'),
      { userId: 'b', tagId: 't1', sourceType: 'weird' as UserTagRow['sourceType'] },
    ])
    expect(mix.total).toBe(1)
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

describe('topTagIntersections：兩兩交集', () => {
  it('少於門檻的組合不列（兩三個人的交集是雜訊）', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row(`u${i}`, 'buyer', 'ai')),
      ...Array.from({ length: 6 }, (_, i) => row(`u${i}`, 'ship', 'ai')),
      row('x', 'rare', 'ai'), row('u0', 'rare', 'ai'),
    ]
    const out = topTagIntersections(rows, { tagIds: ['buyer', 'ship', 'rare'], minUsers: 5 })
    expect(out).toEqual([{ a: 'buyer', b: 'ship', users: 6 }])
  })

  it('只配傳進來的標籤，不會全表兩兩配', () => {
    const rows = [
      row('a', 't1', 'ai'), row('a', 't2', 'ai'), row('a', 't3', 'ai'),
      row('b', 't1', 'ai'), row('b', 't2', 'ai'), row('b', 't3', 'ai'),
    ]
    const out = topTagIntersections(rows, { tagIds: ['t1', 't2'], minUsers: 1 })
    expect(out).toEqual([{ a: 't1', b: 't2', users: 2 }])
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

describe('splitEventVsIntent：名冊 vs 想要什麼', () => {
  const tags = [
    { id: 'survey', name: '問卷 - 乾淨方MAX' }, // 沒有 aiMode ＝ off ＝ 事件紀錄
    { id: 'cs', name: '客服 - BOYA', aiMode: 'off' },
    { id: 'want_coffee', name: '在看咖啡機', aiMode: 'auto' },
    { id: 'ask_price', name: '問過價格優惠', aiMode: 'suggest' },
  ]

  it('照標籤自己有沒有讓 AI 判來分，不是照貼標來源', () => {
    // 意圖標籤被客服手動補上，仍然算意圖（同一顆標籤不會因為誰貼的而改變它在問什麼）
    const out = splitEventVsIntent(
      [
        row('u1', 'survey', 'system'),
        row('u2', 'survey', 'system'),
        row('u3', 'want_coffee', 'ai'),
        row('u4', 'want_coffee', 'manual'),
      ],
      tags,
    )
    expect(out.event.taggings).toBe(2)
    expect(out.intent.taggings).toBe(2)
  })

  it('⛔ 97% 都是問卷時要看得出來意圖那邊很薄，不能被「來源」的漂亮數字蓋住', () => {
    const survey = Array.from({ length: 97 }, (_, i) => row(`u${i}`, 'survey', 'system'))
    const intent = Array.from({ length: 3 }, (_, i) => row(`v${i}`, 'want_coffee', 'ai'))
    const out = splitEventVsIntent([...survey, ...intent], tags)
    expect(out.event.taggings).toBe(97)
    expect(out.intent.taggings).toBe(3)
    expect(out.intent.tags).toBe(2) // 開著 AI 判的標籤顆數，跟貼出來的量是兩回事
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
