import { describe, expect, it } from 'vitest'
import { can } from '~~/shared/permissions'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'
import { shouldRunClickBefore, stepAllowedForRole, stepPreconditionMet } from './tutorial-step-visibility'

/**
 * 步驟級的角色過濾（2026-08-28，客服對話導覽擴到右半邊時加的）。
 *
 * 釘的是：**觀察者不該被帶去看他畫面上根本沒有的按鈕**。拿掉 useTutorial 裡的
 * stepAllowedForRole 之後，第二、三條會紅。
 * `G-109`：條件改成「那顆按鈕打的端點用的能力」，角色照權限表換算（跟頁面上的 can() 同一份）。
 */
const as = (role: WorkspaceMemberRole) => ({ can: (cap: Parameters<typeof can>[1]) => can(role, cap) })
const VIEWER = as('viewer')
const AGENT = as('agent')
const OWNER = as('owner')

describe('stepAllowedForRole', () => {
  it('沒標任何要求的步驟，每種角色都看得到', () => {
    expect(stepAllowedForRole({}, VIEWER)).toBe(true)
    expect(stepAllowedForRole({}, AGENT)).toBe(true)
    expect(stepAllowedForRole({}, OWNER)).toBe(true)
  })

  it('客服級能力的步驟（回覆客人）：觀察者跳過，客服看得到', () => {
    const step = { requires: 'conversations.reply' as const }
    expect(stepAllowedForRole(step, VIEWER)).toBe(false)
    expect(stepAllowedForRole(step, AGENT)).toBe(true)
  })

  it('管理員級能力的步驟（幫同事產綁定連結）：只有 owner/admin 看得到', () => {
    const step = { requires: 'notify.manage' as const }
    expect(stepAllowedForRole(step, VIEWER)).toBe(false)
    expect(stepAllowedForRole(step, AGENT)).toBe(false)
    expect(stepAllowedForRole(step, OWNER)).toBe(true)
  })

  it('問的是那一項能力本身，不是角色高低（`G-109`）', () => {
    // 同一個人：有 A 能力、沒有 B 能力——兩顆大開關表達不出這種情況
    const onlyReply = { can: (cap: string) => cap === 'conversations.reply' }
    expect(stepAllowedForRole({ requires: 'conversations.reply' }, onlyReply)).toBe(true)
    expect(stepAllowedForRole({ requires: 'marketing.write' }, onlyReply)).toBe(false)
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
