/**
 * 「同一件事只准有一個名字」的防漂移測試（`C-210`）。
 *
 * **為什麼要有**：2026-09-21 的 `D-83` 盤點抓到同一個功能在四個地方有四個名字——
 * 側欄「活動標籤」／頁標題「活動貼標」／小幫手帶路「活動」／教學清單「活動貼標（名單分眾）」。
 * 第一次用的人照小幫手講的去側欄找，**找不到那兩個字**，會以為是另一個功能。
 * 這種漂移不會讓任何東西壞掉，所以沒有守門就一定會再發生。
 *
 * **判準＝側欄**（`app/layouts/default.vue` 的 nav items）：側欄名就是指路用的名字。
 *
 * 用讀檔＋比對字串做（不 import）：那兩支都相依 Vue／Element Plus 元件，
 * 在 node 測試環境載不動，而要驗的本來就只是字串。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_DESTINATIONS } from '~~/shared/agent-destinations'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const LAYOUT_FILE = join(APP_DIR, 'layouts/default.vue')

/**
 * 從 `default.vue` 撈出側欄每一項的 label。
 *
 * ⛔ **兩種寫法都要撈**：前三組是 `computed` 陣列裡的 `label: '好友'`，
 * 「設定」那一組卻是直接寫在模板裡的 `<span>組織與 LINE</span>`。
 * 只撈其中一種的話，另一組會**永遠通過**——而那正是這支測試要防的漂移
 * （第一版只撈 `label:`，當場漏掉設定那四項）。
 */
function sidebarLabels(): Set<string> {
  const src = readFileSync(LAYOUT_FILE, 'utf8')
  const labels = new Set<string>()
  for (const m of src.matchAll(/label:\s*'([^']+)'/g)) labels.add(m[1]!)
  // 模板裡的純文字 span（排除有插值或巢狀標籤的）
  for (const m of src.matchAll(/<span>([^<>{}]+)<\/span>/g)) labels.add(m[1]!.trim())
  return labels
}

/**
 * 帶路目的地 → 它對應的側欄項目。
 * ⛔ 沒有對應側欄項目的（例如超管頁）不列在這裡；有列的就一定要同名。
 */
const MUST_MATCH_SIDEBAR: Record<string, string> = {
  'conversations': '客服對話',
  'conversation-stats': '對話統計',
  'flow': '機器人模組',
  'richmenu': '圖文選單',
  'support-presets': '客服預存',
  'ai-scripts': '自動回應',
  'users': '好友',
  'tags': '標籤管理',
  'campaigns': '活動標籤',
  'broadcasts': '推播',
  'ai-usage': 'AI 表現',
  'knowledge-sources': '知識庫',
  'ai-settings': 'AI 設定',
  'settings-organization': '組織與 LINE',
  'settings-billing': '訂閱與付款',
}

describe('小幫手帶路的名字＝側欄的名字', () => {
  it('側欄讀得到 label（讀檔的網要先證明它撈得到東西）', () => {
    // ⛔ 這一關是對照組：正規表示式失效時，下面每一條都會「通過」而其實什麼都沒比對到
    const labels = sidebarLabels()
    expect(labels.size).toBeGreaterThan(10)
    expect(labels.has('客服對話')).toBe(true)
    expect(labels.has('標籤管理')).toBe(true)
  })

  it('每一個帶路目的地的 label 都要跟側欄一字不差', () => {
    const labels = sidebarLabels()
    const mismatched: string[] = []
    for (const [id, expected] of Object.entries(MUST_MATCH_SIDEBAR)) {
      const dest = (AGENT_DESTINATIONS as Record<string, { label: string }>)[id]
      if (!dest) {
        mismatched.push(`${id}：白名單裡沒有這個目的地`)
        continue
      }
      if (dest.label !== expected) {
        mismatched.push(`${id}：帶路寫「${dest.label}」、這裡期望「${expected}」`)
      }
      if (!labels.has(expected)) {
        mismatched.push(`${id}：側欄找不到「${expected}」——是側欄改名了嗎？兩邊要一起改`)
      }
    }
    expect(mismatched).toEqual([])
  })

  it('⛔ 標籤管理一定要在帶路白名單裡', () => {
    // 它以前不在，所以小幫手講得出「標籤是分眾的依據」卻帶不了路——
    // 而標籤正是模組貼標與推播挑名單共同的前提
    expect(Object.keys(AGENT_DESTINATIONS)).toContain('tags')
  })
})
