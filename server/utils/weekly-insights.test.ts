/**
 * 洞察週報（weekly-insights.ts）。
 * 釘的行為：
 *   1. 只有週一附段（台北日曆日判定，別被時區弄歪）。
 *   2. 「全部觀察為零 → 整段不出現」——D-25 的信任靠「講的都有料」，空話會教店家忽略它。
 *   3. 「沒互動」系統標不進「被貼最多」排行（它會蓋掉真正的主題訊號），單獨一行講。
 *   4. 取樣撞上限要講明，別讓「+1,000」被當精確值。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) },
}))
vi.mock('./inactive-tag', () => ({ INACTIVE_TAG_CODE: 'sys_inactive' }))

import { isTaipeiMonday, aggregateTagAdds, formatWeeklyInsightLines } from './weekly-insights'

describe('isTaipeiMonday', () => {
  it('2026-08-24 是週一 → true；前後兩天 false', () => {
    expect(isTaipeiMonday('2026-08-24')).toBe(true)
    expect(isTaipeiMonday('2026-08-23')).toBe(false) // 週日
    expect(isTaipeiMonday('2026-08-25')).toBe(false) // 週二
  })
})

describe('aggregateTagAdds', () => {
  it('多到少排序；空值剔除', () => {
    expect(aggregateTagAdds(['a', 'b', 'a', '', 'a', 'b', 'c'])).toEqual([
      { tagId: 'a', count: 3 },
      { tagId: 'b', count: 2 },
      { tagId: 'c', count: 1 },
    ])
  })

  it('全空 → 空陣列', () => {
    expect(aggregateTagAdds([])).toEqual([])
    expect(aggregateTagAdds(['', '  '])).toEqual([])
  })
})

describe('formatWeeklyInsightLines', () => {
  const empty = {
    rangeText: '8/17–8/24',
    topTags: [],
    inactiveAdds: { count: 0, name: '' },
    pendingSuggestUsers: 0,
    quietDown: 0,
    truncated: false,
  }

  it('全部為零 → null（整段不出現，不硬湊空話）', () => {
    expect(formatWeeklyInsightLines(empty)).toBeNull()
  })

  it('有料時第一行是帶區間的標題，各觀察一行、附下一步', () => {
    const lines = formatWeeklyInsightLines({
      ...empty,
      topTags: [{ name: '送禮客群', count: 12 }, { name: 'VIP', count: 3 }],
      pendingSuggestUsers: 5,
      quietDown: 23,
    })!
    expect(lines[0]).toBe('📈 本週顧客觀察（8/17–8/24）')
    expect(lines[1]).toContain('「送禮客群」+12 位、「VIP」+3 位')
    expect(lines[1]).toContain('好友頁') // 每條觀察都要有「去哪看」
    expect(lines.find(l => l.includes('AI 標籤建議'))).toContain('5 位')
    expect(lines.find(l => l.includes('安靜下來'))).toContain('23 位')
  })

  it('「沒互動」單獨一行講、帶喚醒的下一步（不混進被貼最多排行）', () => {
    const lines = formatWeeklyInsightLines({
      ...empty,
      inactiveAdds: { count: 7, name: '60 天沒互動' },
    })!
    expect(lines).toHaveLength(2) // 標題＋一行
    expect(lines[1]).toContain('7 位')
    expect(lines[1]).toContain('60 天沒互動')
    expect(lines[1]).toContain('推播')
  })

  it('取樣撞上限 → 收尾補「取樣」聲明（別讓數字被當精確值）', () => {
    const lines = formatWeeklyInsightLines({
      ...empty,
      topTags: [{ name: 'VIP', count: 999 }],
      truncated: true,
    })!
    expect(lines.at(-1)).toContain('取樣')
  })

  it('truncated 但沒有任何觀察 → 照樣 null（聲明不能單獨成段）', () => {
    expect(formatWeeklyInsightLines({ ...empty, truncated: true })).toBeNull()
  })
})
