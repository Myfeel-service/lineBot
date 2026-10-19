/**
 * 買之前看得到的地方要講同一套話（`D-131`／`D-59`，2026-10-19）。
 *
 * 這幾個面向以前各說各的：官網方案卡、`/product-info`、後台付款彈窗只寫「每月 AI 回覆 N 則」，
 * 沒講反問算不算、答不出來算不算、跟 LINE 的訊息則數有沒有關係；推播各方案不同卻哪裡都沒寫；
 * 條款漏了「草稿模式也算」；付款彈窗還列著一欄沒有地方在擋的「API」。
 * 這支直接讀頁面原始碼：哪一面把共用的那句拿掉、或改回自己造句，就紅。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPLY_UNIT_SHORT, REPLY_UNIT_TIP } from './usage-units'

const ROOT = join(__dirname, '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('「什麼算一則」短版（買之前看得到的三處同一句）', () => {
  it('講齊三件事：反問也算、答不出轉真人不算、跟 LINE 的訊息則數無關', () => {
    expect(REPLY_UNIT_SHORT).toContain('反問也算')
    expect(REPLY_UNIT_SHORT).toContain('轉真人的不算')
    expect(REPLY_UNIT_SHORT).toContain('LINE 官方帳號的訊息則數無關')
  })

  it('字是從完整版摘出來的（同一組詞，不另外造句）', () => {
    for (const phrase of ['出手回答一次', '反問', '答不出來、轉真人', 'LINE 官方帳號']) {
      expect(REPLY_UNIT_TIP, phrase).toContain(phrase)
      expect(REPLY_UNIT_SHORT, phrase).toContain(phrase)
    }
  })

  it('官網方案卡底下、/product-info、付款彈窗的 ⓘ 都畫這一句', () => {
    expect(src('app/pages/index.vue')).toContain('{{ REPLY_UNIT_SHORT }}')
    expect(src('app/pages/product-info.vue')).toContain('{{ REPLY_UNIT_SHORT }}')
    expect(src('app/components/admin/AdminPlanUpgradeDialog.vue')).toContain('{{ REPLY_UNIT_SHORT }}')
  })
})

describe('推播分級寫在方案表上（D-131①）', () => {
  it('官網方案卡多一列推播、付款彈窗多一欄推播（字都從 plans.ts 來）', () => {
    expect(src('app/pages/index.vue')).toContain('broadcastTierSpec(p.broadcast)')
    const dialog = src('app/components/admin/AdminPlanUpgradeDialog.vue')
    expect(dialog).toContain('{{ broadcastCell(row) }}')
    expect(dialog).toContain('BROADCAST_SEGMENT_HINT')
  })

  it('條款與 /product-info 都講各方案的推播（同一句）', () => {
    expect(src('app/pages/terms.vue')).toContain('<li><b>推播</b>：{{ broadcastSummary }}')
    expect(src('app/pages/product-info.vue')).toContain('推播：{{ broadcastSummary }}')
  })

  it('⛔ 付款彈窗不再列「API」欄（D-59：沒有地方在擋，不寫成方案差異）', () => {
    expect(src('app/components/admin/AdminPlanUpgradeDialog.vue')).not.toMatch(/label="API"|row\.api/)
  })
})

describe('條款「什麼算一則」補上草稿模式（D-131③）', () => {
  it('條款寫了草稿模式也算一則', () => {
    expect(src('app/pages/terms.vue')).toContain('草稿模式下 AI 擬好回覆給客服參考，也算一則')
  })
})
