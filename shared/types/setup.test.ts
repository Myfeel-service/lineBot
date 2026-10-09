import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_DESTINATIONS } from '../agent-destinations'
import { SETUP_LABELS, SETUP_PAGE, setupPagePath, type SetupCapabilityId } from './setup'

/**
 * 每一項設定「在哪一頁做」只有一份（2026-10-10 審查）：
 * 以前前端健康卡（`useSetupStatus`）與小幫手 `get_setup_status` 各寫一份，頁面搬家只改到一邊，
 * 小幫手就會一直把人帶去舊頁。
 */
describe('設定項目在哪一頁做：只有一份', () => {
  it('每一項都有對得到的頁面', () => {
    for (const id of Object.keys(SETUP_LABELS) as SetupCapabilityId[]) {
      expect(AGENT_DESTINATIONS[SETUP_PAGE[id]], id).toBeTruthy()
      expect(setupPagePath(id, 'w1'), id).toMatch(/^\/admin\/w1\//)
    }
  })

  it('「認識你的店」在組織頁（`D-116`：它曾被帶到 AI 設定）', () => {
    expect(setupPagePath('profileReady', 'w1')).toBe('/admin/w1/settings/organization')
  })

  it('⛔ 前端健康卡不可以再自己寫路徑（一律走 setupPagePath）', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'app', 'composables', 'useSetupStatus.ts'), 'utf8')
    expect(src).not.toMatch(/route:\s*wid\s*=>\s*`/)
  })
})
