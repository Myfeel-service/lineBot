import { describe, expect, it } from 'vitest'
import {
  allSkippedText,
  isSkipped,
  normalizeSkipMap,
  pruneSkipMap,
  restoredText,
  skippedNoticeText,
  skippedToastText,
  SKIP_MAP_MAX,
  splitBySkip,
} from './marketing-skips'

const E = (festivalId: string, name: string) => ({ festivalId, name })
const MID = E('midautumn-2026', '中秋節')
const NAT = E('nationalday-2026', '國慶日')
const XMAS = E('christmas-2026', '聖誕節')

describe('normalizeSkipMap', () => {
  it('正常的留著', () => {
    expect(normalizeSkipMap({ 'midautumn-2026': 1700000000000 })).toEqual({ 'midautumn-2026': 1700000000000 })
  })

  it('⛔ 壞掉的一律丟掉，不要炸掉整張卡', () => {
    expect(normalizeSkipMap(null)).toEqual({})
    expect(normalizeSkipMap([1, 2])).toEqual({})
    expect(normalizeSkipMap({ '': 1 })).toEqual({})
    expect(normalizeSkipMap({ x: 0 })).toEqual({})
    expect(normalizeSkipMap({ x: -1 })).toEqual({})
    expect(normalizeSkipMap({ x: 'abc' })).toEqual({})
  })

  it('⛔ 含「.」的 key 丟掉（Firestore 的 map key 不吃，會被當成巢狀欄位路徑）', () => {
    expect(normalizeSkipMap({ 'a.b': 123 })).toEqual({})
  })
})

describe('splitBySkip', () => {
  it('分得開', () => {
    const { visible, skipped } = splitBySkip([MID, NAT, XMAS], { 'nationalday-2026': 1 })
    expect(visible.map(v => v.name)).toEqual(['中秋節', '聖誕節'])
    expect(skipped.map(v => v.name)).toEqual(['國慶日'])
  })

  it('一檔都沒收就全部顯示', () => {
    expect(splitBySkip([MID, NAT], {}).skipped).toEqual([])
  })

  it('isSkipped 認得出來', () => {
    expect(isSkipped({ 'midautumn-2026': 1 }, 'midautumn-2026')).toBe(true)
    expect(isSkipped({}, 'midautumn-2026')).toBe(false)
  })
})

describe('⭐ 明年那一檔自然會回來（鐵律②：id 本來就含年份）', () => {
  it('收起 2026 的中秋，不會連 2027 的一起收掉', () => {
    const map = { 'midautumn-2026': 1 }
    expect(isSkipped(map, 'midautumn-2026')).toBe(true)
    expect(isSkipped(map, 'midautumn-2027')).toBe(false)
  })
})

describe('pruneSkipMap', () => {
  it('沒超過上限就原樣', () => {
    const m = { a: 1, b: 2 }
    expect(pruneSkipMap(m)).toEqual(m)
  })

  it('⛔ 不要無限成長：超過就留最近收的那幾筆', () => {
    const big: Record<string, number> = {}
    for (let i = 0; i < SKIP_MAP_MAX + 10; i++) big[`f${i}`] = i + 1
    const pruned = pruneSkipMap(big)
    expect(Object.keys(pruned)).toHaveLength(SKIP_MAP_MAX)
    // 時間最新的留著、最舊的被剪掉
    expect(pruned[`f${SKIP_MAP_MAX + 9}`]).toBeDefined()
    expect(pruned.f0).toBeUndefined()
  })
})

describe('話要講出來（鐵律①③：⛔ 不可以靜靜消失）', () => {
  it('一檔都沒收就整列不出現', () => {
    expect(skippedNoticeText([])).toBe('')
    expect(allSkippedText([])).toBe('')
  })

  it('收起來的要列出名字', () => {
    const t = skippedNoticeText([MID, NAT])
    expect(t).toContain('中秋節')
    expect(t).toContain('國慶日')
  })

  it('收太多時不要列一長串', () => {
    const many = Array.from({ length: 7 }, (_, i) => E(`f${i}`, `節${i}`))
    const t = skippedNoticeText(many)
    expect(t).toContain('等 7 檔')
    expect(t).not.toContain('節6')
  })

  it('⛔ 全部收起來時要講「是你自己收的」並指路還原，不可以只剩空白', () => {
    const t = allSkippedText([MID, NAT])
    expect(t).toContain('2 檔')
    expect(t).toContain('還原')
  })

  it('⛔ 收起來的提示一定要講「明年還是會出現」（否則會被當成永久刪除）', () => {
    expect(skippedToastText('中秋節')).toContain('明年')
  })

  it('還原有回饋', () => {
    expect(restoredText('中秋節')).toContain('中秋節')
  })
})
