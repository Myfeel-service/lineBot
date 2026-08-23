/**
 * 標籤範本庫（D-27③）。守三件事：
 *   1. code 唯一且格式合法（後端 create 的 regex）——撞號或壞格式會讓一鍵建立整批卡住。
 *   2. 判斷條件非空且 ≤200 字（編輯器 maxlength ＝ prompt 上限，超了會被切）。
 *   3. 分類是合法值（後端白名單擋，錯了 400）。
 */
import { describe, it, expect } from 'vitest'
import { TAG_TEMPLATES } from './tag-templates'

const VALID_CATEGORIES = ['member_status', 'interest', 'behavior', 'activity', 'custom']

describe('TAG_TEMPLATES', () => {
  it('8 顆、code 唯一且符合後端格式（英文小寫開頭，數字底線）', () => {
    expect(TAG_TEMPLATES).toHaveLength(8)
    const codes = TAG_TEMPLATES.map(t => t.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) expect(code).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('每顆都有名稱、判斷條件（≤200 字）、用途說明、合法分類', () => {
    for (const t of TAG_TEMPLATES) {
      expect(t.name.trim()).toBeTruthy()
      expect(t.criteria.trim()).toBeTruthy()
      expect(t.criteria.length).toBeLessThanOrEqual(200)
      expect(t.usage.trim()).toBeTruthy()
      expect(VALID_CATEGORIES).toContain(t.category)
      expect(t.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  it('條件都寫了「不算」的排除句或明確界線——只寫「什麼算」的條件容易過度貼標', () => {
    // 至少一半的範本要有排除語（不算／只問…的不算），這是寫法公式的示範作用
    const withExclusion = TAG_TEMPLATES.filter(t => t.criteria.includes('不算'))
    expect(withExclusion.length).toBeGreaterThanOrEqual(4)
  })
})
