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

import { isTaipeiMonday, aggregateTagAdds, formatWeeklyInsightLines, weeklyWindow } from './weekly-insights'

describe('isTaipeiMonday', () => {
  it('2026-08-24 是週一 → true；前後兩天 false', () => {
    expect(isTaipeiMonday('2026-08-24')).toBe(true)
    expect(isTaipeiMonday('2026-08-23')).toBe(false) // 週日
    expect(isTaipeiMonday('2026-08-25')).toBe(false) // 週二
  })
})

describe('weeklyWindow：台北日曆週，不是發送時刻往回 7×24h（G-22①）', () => {
  it('週一 8/24 發 → 窗口＝8/17 00:00～8/24 00:00（台北），標題 8/17–8/23', () => {
    const w = weeklyWindow('2026-08-24')
    expect(w.endMs).toBe(Date.parse('2026-08-24T00:00:00+08:00'))
    expect(w.startMs).toBe(Date.parse('2026-08-17T00:00:00+08:00'))
    expect(w.rangeText).toBe('8/17–8/23') // 週一到週日七個日曆日，不是橫跨八天的 8/17–8/24
  })

  it('同一週不論幾點重算，窗口一個毫秒都不動（可重現、可對帳）', () => {
    expect(weeklyWindow('2026-08-24')).toEqual(weeklyWindow('2026-08-24'))
  })

  it('跨月的週：9/7 發 → 標題 8/31–9/6', () => {
    expect(weeklyWindow('2026-09-07').rangeText).toBe('8/31–9/6')
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
    // ⛔ 指路要用**側欄的名字**「好友」——側欄叫什麼訊息就寫什麼（G-22③／2026-08-23 統一改名）
    expect(lines[1]).toContain('「好友」頁')
    // 「會員」已於 2026-08-23 全面退場（側欄／頁題／訊息一律「好友」）——別讓它從指路文案復活
    expect(lines.join('\n')).not.toContain('會員')
    expect(lines.find(l => l.includes('貼標建議'))).toContain('「好友」頁')
    expect(lines.find(l => l.includes('貼標建議'))).toContain('5 位')
    // 文案要跟資料窗口（14~28 天前）一字不差，不寫「上個月」；而且要有下一步（G-22②④）
    const quiet = lines.find(l => l.includes('兩週沒再出現'))!
    expect(quiet).toContain('23 位')
    expect(quiet).toContain('AI 設定') // 這一行不准是唯一沒有下一步的
    expect(quiet).not.toContain('上個月')
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
