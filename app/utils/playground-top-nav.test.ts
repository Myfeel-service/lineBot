import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TUTORIAL_TOPICS } from './tutorial-topics'

/**
 * `D-173`（John 哥 11-04「把測試獨立成一個抬頭…甚至我會把測試對話放在最上面」）：
 * 測試對話自己一段、在側欄最上面；「AI 客服」那段不再放第二個入口；「認識後台」地圖從它講起。
 */
const layout = readFileSync(resolve(__dirname, '../layouts/default.vue'), 'utf8')

describe('測試對話在側欄最上面（`D-173`）', () => {
  it('自己一段、排在「每天在用的」前面', () => {
    const test = layout.indexOf('data-tour="nav-group-test"')
    const daily = layout.indexOf('data-tour="nav-group-daily"')
    expect(test).toBeGreaterThan(0)
    expect(test).toBeLessThan(daily)
    expect(layout).toContain('<div class="nav-section-label">改完來這試</div>')
  })

  it('⛔ 「AI 客服」那段不再有測試對話（同一頁兩個入口）', () => {
    const i = layout.indexOf('const aiNavItems')
    const block = layout.slice(i, layout.indexOf('})', i))
    expect(block).not.toContain('/ai-playground`')
  })

  it('會花 token：客服以上才看得到（playground.use）', () => {
    const i = layout.indexOf('const testNavItem')
    expect(layout.slice(i, i + 300)).toContain("can('playground.use')")
  })

  it('「認識後台」第一步就是它', () => {
    const overview = TUTORIAL_TOPICS.find(t => t.steps.some(s => s.target === '[data-tour="nav-group-test"]'))
    expect(overview?.steps[0]?.target).toBe('[data-tour="nav-group-test"]')
    expect(overview?.steps[0]?.requires).toBe('playground.use')
  })
})
