import { describe, expect, it } from 'vitest'
import { shouldRunClickBefore, stepAllowedForRole, stepPreconditionMet } from './tutorial-step-visibility'

/**
 * 步驟級的角色過濾（2026-08-28，客服對話導覽擴到右半邊時加的）。
 *
 * 釘的是：**觀察者不該被帶去看他畫面上根本沒有的按鈕**。拿掉 useTutorial 裡的
 * stepAllowedForRole 之後，第二、三條會紅。
 */
const AGENT = { canOperate: true, canManageSettings: false }
const VIEWER = { canOperate: false, canManageSettings: false }
const OWNER = { canOperate: true, canManageSettings: true }

describe('stepAllowedForRole', () => {
  it('沒標任何要求的步驟，每種角色都看得到', () => {
    expect(stepAllowedForRole({}, VIEWER)).toBe(true)
    expect(stepAllowedForRole({}, AGENT)).toBe(true)
    expect(stepAllowedForRole({}, OWNER)).toBe(true)
  })

  it('要操作權限的步驟：觀察者跳過，客服看得到', () => {
    const step = { requiresOperate: true }
    expect(stepAllowedForRole(step, VIEWER)).toBe(false)
    expect(stepAllowedForRole(step, AGENT)).toBe(true)
  })

  it('要設定權限的步驟：只有 owner/admin 看得到', () => {
    const step = { requiresSettings: true }
    expect(stepAllowedForRole(step, VIEWER)).toBe(false)
    expect(stepAllowedForRole(step, AGENT)).toBe(false)
    expect(stepAllowedForRole(step, OWNER)).toBe(true)
  })

  it('兩個都要時，缺一不可', () => {
    const step = { requiresOperate: true, requiresSettings: true }
    expect(stepAllowedForRole(step, AGENT)).toBe(false)
    expect(stepAllowedForRole(step, OWNER)).toBe(true)
  })
})

describe('stepPreconditionMet：空資料的帳號不要跑進死步', () => {
  const has = (present: string[]) => (sel: string) => present.includes(sel)

  it('沒填前提的步驟一律照跑', () => {
    expect(stepPreconditionMet({}, has([]))).toBe(true)
  })

  it('前提在畫面上 → 跑（有對話可以點開）', () => {
    expect(stepPreconditionMet({ requiresPresent: '.row' }, has(['.row']))).toBe(true)
  })

  it('前提不在畫面上 → 整步跳過（⛔這行紅掉＝空收件匣的新帳號會連續乾等五次兩秒）', () => {
    expect(stepPreconditionMet({ requiresPresent: '.row' }, has([]))).toBe(false)
  })
})

describe('shouldRunClickBefore：不要把使用者手上的東西切掉', () => {
  const has = (present: string[]) => (sel: string) => present.includes(sel)

  it('沒有 clickBefore 就沒事可做', () => {
    expect(shouldRunClickBefore({}, has([]))).toBe(false)
  })

  it('沒設條件的照舊點（沿用原本行為）', () => {
    expect(shouldRunClickBefore({ clickBefore: '.row' }, has([]))).toBe(true)
  })

  it('還沒開任何一場 → 幫他點開第一場', () => {
    expect(shouldRunClickBefore(
      { clickBefore: '.row', clickBeforeUnless: '.opened' },
      has(['.row']),
    )).toBe(true)
  })

  it('已經開著一場 → 不要點（⛔這行紅掉＝客服正在回覆的對話會被導覽切走）', () => {
    expect(shouldRunClickBefore(
      { clickBefore: '.row', clickBeforeUnless: '.opened' },
      has(['.row', '.opened']),
    )).toBe(false)
  })
})
