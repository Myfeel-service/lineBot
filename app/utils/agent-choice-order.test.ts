import { describe, expect, it } from 'vitest'
import { orderAgentChoices } from './agent-choice-order'

/**
 * 選項鈕的版面順序（2026-08-28 拍板）。
 *
 * 這組測試釘的是「主要鈕在最右、跳過類在最左」——把 orderAgentChoices 改回原樣
 * （直接回傳 options）時，第一條與第三條會紅。
 */
describe('orderAgentChoices', () => {
  it('主要動作排到最後（＝靠右對齊時的最右邊）', () => {
    const out = orderAgentChoices([
      { label: '教我一步步拿', value: 'walk', primary: true },
      { label: '我會拿，直接貼上', value: 'paste' },
    ])
    expect(out.map(o => o.value)).toEqual(['paste', 'walk'])
    expect(out.at(-1)?.primary).toBe(true)
  })

  it('跳過／離開類排到最前面（＝最左邊，遠離拇指與主要鈕）', () => {
    const out = orderAgentChoices([
      { label: '幫我再驗一次 Webhook', value: 'verify', primary: true },
      { label: '檢查好了，繼續等', value: 'wait' },
      { label: '改前面的設定', value: 'redo' },
      { label: '先跳過測試', value: 'skip', escape: true },
    ])
    expect(out.map(o => o.value)).toEqual(['skip', 'wait', 'redo', 'verify'])
  })

  it('同一段裡的相對順序不動（劇本是刻意那樣排的）', () => {
    const out = orderAgentChoices([
      { label: 'A', value: 'a' },
      { label: 'B', value: 'b' },
      { label: 'C', value: 'c' },
    ])
    expect(out.map(o => o.value)).toEqual(['a', 'b', 'c'])
  })

  it('既是主要動作又標了跳過時，跳過優先（不會兩段都出現、也不會漏掉）', () => {
    const out = orderAgentChoices([
      { label: '別的', value: 'other' },
      { label: '怪組合', value: 'weird', primary: true, escape: true },
    ])
    expect(out.map(o => o.value)).toEqual(['weird', 'other'])
    expect(out).toHaveLength(2)
  })

  it('空清單不會爆', () => {
    expect(orderAgentChoices([])).toEqual([])
  })
})

describe('呼叫端不可以讓 primary 隨狀態換人（2026-08-28 code review）', () => {
  /**
   * 排版規則是「主要動作排最後」，所以 primary 換人＝兩顆鈕互換位置。
   * 實際踩過的坑：貼 Webhook 那一步的 walk/check 依「有沒有看過教學」翻轉 primary，
   * 使用者走完教學回來，要按的那顆從第 2 顆跑到第 4 顆，原位置變成他剛做完的事。
   * ⛔ 這條紅掉＝又有人把 primary 寫成條件式，位置會在使用者眼前跳。
   */
  it('開通引導的選項沒有條件式的 primary', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      fileURLToPath(new URL('../composables/useOnboardingChat.ts', import.meta.url)),
      'utf8',
    )
    const conditional = [...src.matchAll(/primary:\s*([^,\n}]+)/g)]
      .map(m => m[1]!.trim())
      .filter(v => v !== 'true')
    expect(conditional).toEqual([])
  })
})
