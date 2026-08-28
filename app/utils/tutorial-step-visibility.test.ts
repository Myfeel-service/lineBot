import { describe, expect, it } from 'vitest'
import { stepAllowedForRole } from './tutorial-step-visibility'

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
