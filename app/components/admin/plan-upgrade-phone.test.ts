/**
 * 手機上的方案表（`B-55`，2026-11-11）——讀元件原始碼守門。
 *
 * 守的是兩件會靜靜壞掉的事：
 *   ① 手機那一版被拿掉（又變回一張要左右滑的表，月費與按鈕在畫面外）。
 *   ② **收錢那顆按鈕被複製成兩份**。桌機與手機共用 `AdminPlanActionCell` 是刻意的：
 *      兩邊各寫一份的話，某一天只有一邊會記得「期末降級」要講期末、只有一邊記得沒勾同意要鎖住。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const DIALOG = 'app/components/admin/AdminPlanUpgradeDialog.vue'
const CELL = 'app/components/admin/AdminPlanActionCell.vue'

describe('手機上一個方案一張卡（B-55）', () => {
  it('那張比較表只在非手機時畫，手機畫卡片', () => {
    const s = src(DIALOG)
    expect(s).toContain('v-if="!isPhone"')
    expect(s).toContain('class="pu-cards"')
    // 斷點用全站同一支，⛔ 別自己另訂一個（兩套斷點會在某個寬度之間打架）
    expect(s).toContain('usePhoneLayout()')
  })

  it('卡片上四項規格一項不少（跟桌機那張表同一組）', () => {
    const cards = src(DIALOG).split('class="pu-cards"')[1] ?? ''
    for (const label of ['每月則數', 'AI 知識量', '席次', '推播']) {
      expect(cards, label).toContain(label)
    }
    // 月費與按鈕就是這次要救的兩樣，一定要在卡片裡
    expect(cards).toContain('priceLabel(p)')
    expect(cards).toContain('<AdminPlanActionCell')
  })

  it('⛔ 收錢那顆按鈕只有一份：兩種版面都用同一個元件', () => {
    const s = src(DIALOG)
    expect(s.match(/<AdminPlanActionCell/g)?.length).toBe(2)
    // 按鈕本體（含「期末降級」那句）只能住在那個元件裡。
    // ⚠️ 只比 template：script 裡的「期末降級」是確認框的按鈕字與埋點欄位，兩件不同的事。
    const template = s.split('<script setup')[0]!
    expect(template).not.toContain('期末降級')
    expect(src(CELL)).toContain('期末降級')
  })

  it('手機上把桌機那三顆 ⓘ 的字直接寫出來（tooltip 在手機上形同消失）', () => {
    const cards = src(DIALOG).split('class="pu-cards"')[1] ?? ''
    for (const token of ['REPLY_UNIT_SHORT', 'KNOWLEDGE_UNIT_SHORT', 'BROADCAST_SEGMENT_HINT']) {
      expect(cards, token).toContain(token)
    }
  })
})
