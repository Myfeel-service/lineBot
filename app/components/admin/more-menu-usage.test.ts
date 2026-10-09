import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 編輯頁右上角的次要動作（`C-294`，2026-10-09）：複製、刪除一律收在共用的 `AdminMoreMenu`（「⋯」）。
 *
 * 為什麼要鎖：統一之前全站三種做法並存——機器人模組收在「⋯」、自動回應是「複製一份」＋紅色「刪除」兩顆按鈕、
 * 另外四頁是紅色「刪除」按鈕；「⋯」的樣式還被 Element 的預設內距蓋掉好幾週沒人發現（`E-36`）。
 * 規則見 `docs/COPY-RULES-AND-INVENTORY-20261009.md`。
 */

const APP = join(__dirname, '..', '..')

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return vueFiles(p)
    return p.endsWith('.vue') ? [p] : []
  })
}

const files = vueFiles(APP).map(p => ({ path: relative(APP, p), src: readFileSync(p, 'utf8') }))

describe('編輯頁的「⋯」只有一份', () => {
  it('⛔ 不可以在頁面裡自己拼一顆「⋯」（`admin-more-btn`、`MoreFilled` 圖示只准出現在共用元件）', () => {
    // 2026-10-10 審查：成員管理、LINE 通知的表格列各拼了一份 el-dropdown＋MoreFilled，紅字樣式有三份
    const offenders = files
      .filter(f => f.path !== 'components/admin/MoreMenu.vue')
      .filter(f => f.src.includes('admin-more-btn') || f.src.includes(':icon="MoreFilled"'))
      .map(f => f.path)
    expect(offenders).toEqual([])
  })

  it('⛔ 危險項的紅字樣式只有一份（`.admin-more-item--danger`）', () => {
    const scss = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? scss(p) : (p.endsWith('.scss') ? [p] : [])
    })
    const offenders = scss(join(APP, 'assets', 'scss'))
      .filter(p => /\.el-dropdown-menu__item\.[a-z-]*danger/.test(readFileSync(p, 'utf8')))
      .map(p => relative(APP, p))
    expect(offenders).toEqual([])
  })

  it('⛔ 標題列不可以再擺紅色「刪除」按鈕（收進「⋯」）', () => {
    const redDelete = /<el-button[^>]*:icon="Delete"[^>]*type="danger"[^>]*>\s*刪除\s*<\/el-button>/
    const offenders = files.filter(f => redDelete.test(f.src)).map(f => f.path)
    expect(offenders).toEqual([])
  })

  it('有複製功能的三頁都接上了共用的「⋯」與「先存再複製」', () => {
    for (const page of ['flow.vue', 'broadcasts.vue', 'ai-scripts.vue']) {
      const f = files.find(x => x.path === `pages/admin/[workspaceId]/${page}`)
      expect(f, page).toBeTruthy()
      expect(f!.src, page).toContain('<AdminMoreMenu')
      expect(f!.src, page).toContain("command: 'duplicate'")
      expect(f!.src, page).toContain('confirmSaveBeforeCopy()')
    }
  })
})
