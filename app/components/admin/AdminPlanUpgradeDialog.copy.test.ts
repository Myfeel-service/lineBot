import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 守門測試：升級視窗要講明付款方式（`B-54`①，2026-11-11）。
 *
 * 為什麼釘住：按下升級就離開本站、跳去 PAYUNi 的付款頁，而那一頁因為要同時建立每月扣款的
 * 約定，**只有信用卡一種**（2026-11-11 對照實測：同一個正式特店不帶建約定參數時，付款頁
 * 給的是信用卡＋分期＋Apple／Google／Samsung Pay＋ATM＋超商；一帶上 `UseTokenType=3`
 * 就只剩 Credit）。以前這裡只寫「付款由統一金流 PAYUNi 處理」，沒有信用卡的人要走到付款頁
 * 才發現沒有別的選項——那是他已經決定要買、正要掏卡的最後一哩。
 *
 * ⛔ 「從同一張卡」那半句不是贅字：它是在回答「為什麼只能刷卡」，拿掉就只剩結論沒有理由。
 * 元件在 node 測試環境掛不起來，所以讀原始碼驗字；畫面上真的有，由 scratchpad 的實機守門員驗過。
 */

const SRC = readFileSync(fileURLToPath(new URL('./AdminPlanUpgradeDialog.vue', import.meta.url)), 'utf8')
/** 拿掉註解：只驗畫面上會出現的字 */
const TEMPLATE = SRC
  .replace(/<!--[\s\S]*?-->/g, '')
  .slice(0, SRC.replace(/<!--[\s\S]*?-->/g, '').indexOf('<script'))

describe('升級視窗：付款方式', () => {
  it('講明付款方式為信用卡（用字與 /terms 第 7 條、頁尾一致）', () => {
    expect(TEMPLATE).toContain('付款方式為信用卡')
    // ⛔ 舊的寫法沒有「信用卡」三個字，不可以退回去
    expect(TEMPLATE).not.toContain('付款由統一金流 PAYUNi 處理')
  })

  it('自動扣款開著時，要講清楚是從同一張卡扣——那是「為什麼只能刷卡」的理由', () => {
    expect(TEMPLATE).toContain('每月自動從同一張卡續扣')
    expect(TEMPLATE).toMatch(/v-if="recurringEnabled"[^>]*>[^<]*每月自動從同一張卡續扣/)
  })

  it('⛔ 付款方式那句不可以藏在只有自動扣款開著才顯示的地方（關掉旗標時一樣要講）', () => {
    const recurringOnly = TEMPLATE.slice(TEMPLATE.indexOf('v-if="recurringEnabled"'))
    expect(recurringOnly).not.toContain('付款方式為信用卡')
  })
})
