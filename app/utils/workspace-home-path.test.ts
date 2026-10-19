/**
 * 進一個官方帳號落在哪一頁（`G-13`，2026-10-20 老闆照建議）：
 * 沒接上 LINE 的帳號落測試對話（跟打造那一趟的出口同一頁），其他照舊落對話統計。
 * 三個入口（帳號選擇頁、組織頁、`/admin/{wid}`）都要走同一支判斷。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { onboardingBuiltLandingPath, workspaceHomePath } from '~/composables/useOnboardingChat'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const src = (p: string) => readFileSync(`${APP_DIR}${p}`, 'utf8')
/** 取出某支函式的本體（到下一個頂層 `}` 為止），只看那一段 */
function fnBody(code: string, header: string): string {
  const at = code.indexOf(header)
  expect(at, `找不到「${header}」`).toBeGreaterThanOrEqual(0)
  return code.slice(at, code.indexOf('\n}', at) + 2)
}

describe('workspaceHomePath（G-13）', () => {
  it('確定沒接上 LINE、看得到測試對話 → 落測試對話（＝打造那一趟的出口）', () => {
    expect(workspaceHomePath('w1', 'incomplete', true)).toBe(onboardingBuiltLandingPath('w1'))
    expect(workspaceHomePath('w1', 'incomplete', true)).toBe('/admin/w1/ai-playground')
  })

  it('接上了 → 照舊落對話統計', () => {
    expect(workspaceHomePath('w1', 'done', true)).toBe('/admin/w1/conversation-stats')
  })

  it('⛔ 查不到／還沒問到不算「沒接」→ 照舊落對話統計', () => {
    expect(workspaceHomePath('w1', 'unknown', true)).toBe('/admin/w1/conversation-stats')
    expect(workspaceHomePath('w1', undefined, true)).toBe('/admin/w1/conversation-stats')
  })

  it('觀察者（沒有 playground.use）→ 照舊落對話統計，不送去會被擋的頁', () => {
    expect(workspaceHomePath('w1', 'incomplete', false)).toBe('/admin/w1/conversation-stats')
  })
})

describe('三個入口都走同一支（⛔ 不在入口各寫一份落點）', () => {
  it('/admin/{wid} 在 middleware 轉址（⛔ 不在頁面 setup 裡 await navigateTo：直接打網址會整頁空白）', () => {
    const page = src('pages/admin/[workspaceId]/index.vue')
    expect(page).toContain('middleware: [\'auth\', \'workspace-home\']')
    expect(page).not.toMatch(/^\s*await navigateTo/m)
    expect(page).not.toContain('conversation-stats')
  })

  it('workspace-home middleware 用 workspaceHomePath、吃 setup-status 的 lineConnected 與 playground.use，帳號自己帶', () => {
    const mw = src('middleware/workspace-home.ts')
    // 這時 useRoute() 還是上一頁：帳號一律從 to.params 帶（refresh／statusOf／roleFor 三處）
    expect(mw).toContain('setup.refresh({ workspaceId: wid })')
    expect(mw).toContain('workspaceHomePath(wid, setup.statusOf(wid, \'lineConnected\'), can(roleFor(wid), \'playground.use\'))')
    // 體檢太慢不能讓人對著白頁等
    expect(mw).toContain('WORKSPACE_HOME_STATUS_WAIT_MS')
  })

  it('useSetupStatus 的 refresh 吃得到指定帳號、statusOf 對不上帳號就回 undefined', () => {
    const c = src('composables/useSetupStatus.ts')
    expect(c).toContain('const wid = options.workspaceId || workspaceId.value')
    expect(c).toMatch(/function statusOf\(wid: string, id: SetupCapabilityId\)[\s\S]{0,200}checkedFor\.value !== wid[\s\S]{0,40}return undefined/)
  })

  it('帳號選擇頁的「進入」交給 /admin/{wid}', () => {
    const body = fnBody(src('pages/admin/workspaces.vue'), 'async function enter(')
    expect(body).toContain('navigateTo(`/admin/${workspaceId}`)')
    expect(body).not.toContain('conversation-stats')
  })

  it('組織頁的「進入」交給 /admin/{wid}', () => {
    const body = fnBody(src('pages/admin/org/[orgId]/index.vue'), 'function enter(')
    expect(body).toContain('router.push(`/admin/${workspaceId}`)')
    expect(body).not.toContain('conversation-stats')
  })
})
