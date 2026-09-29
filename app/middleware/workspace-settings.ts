import type { WorkspaceMemberRole } from '~~/shared/types/organization'
import { CAPABILITIES, can, type Capability } from '~~/shared/permissions'

/**
 * 每一個設定頁要什麼能力＝**那一頁載入時打的端點**用的能力（`G-109`）。
 * 以前整段 /settings/ 一律寫死「管理員以上」，端點調了門檻這道門也不會跟著動。
 * ⛔ 掛了 `workspace-settings` 卻沒登記在這裡的頁＝誰都進不去（寧可做的人當場發現，也不要誰都進得去）。
 *    `line-notify` 不在這裡：它掛的是自己的 `workspace-notify`。
 */
const SETTINGS_PAGE_CAPABILITY: Record<string, Capability> = {
  members: 'members.read', // GET /api/admin/workspaces/[workspaceId]/members
  organization: 'line.manage', // GET /api/admin/line-workspace
  billing: 'billing.manage', // /api/payment/*（訂單、發票資料）
  activity: 'audit.read', // GET /api/admin/audit-logs
}

/** 擋下來時講的話，照那個能力的最低角色講（管理員級的頁仍是「這一頁只有管理員能進入」） */
const DENIAL_BY_MIN_ROLE: Record<WorkspaceMemberRole, string> = {
  owner: '這一頁只有擁有者能進入',
  admin: '這一頁只有管理員能進入',
  agent: '這一頁要客服以上的權限才能進入',
  viewer: '你沒有這個官方帳號的權限',
}

/**
 * 這個角色能不能待在這個設定頁；不能的話回要講給他聽的那句話，能就回 null。
 *
 * 抽出來是給 `auth.ts` 的背景重驗共用（`G-107` 第 21 條）：進頁時這道門看的是**上次存的
 * 帳號清單**，被降級的管理員在清單更新前照樣進得來。背景那次問完要用**同一把尺**再判一次，
 * ⛔ 不要在 auth.ts 另寫一份「設定頁要什麼權限」——兩份遲早對不上。
 */
export function settingsPageDenial(path: string, role: WorkspaceMemberRole | null): string | null {
  if (!path.includes('/settings/')) return null
  const page = path.split('/settings/')[1]?.split('/')[0] ?? ''
  const capability = SETTINGS_PAGE_CAPABILITY[page]
  if (!capability) return '這一頁還沒設定誰能進入，請聯絡我們'
  if (!can(role, capability)) return DENIAL_BY_MIN_ROLE[CAPABILITIES[capability]]
  return null
}

/**
 * 設定頁（成員管理、組織與 LINE、訂閱與付款、操作紀錄）各看自己那一頁端點的能力，
 * 見上面的 SETTINGS_PAGE_CAPABILITY；直接輸入網址也擋。
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (!to.path.includes('/settings/')) return

  const wid = to.params.workspaceId as string | undefined
  if (!wid) return

  // 用 `to` 的 workspaceId 查角色，不要用 currentRole（守衛裡的 useRoute() 是舊路由）
  const { ensureWorkspaceList, roleFor } = useWorkspace()
  const { loaded } = await ensureWorkspaceList()
  if (!loaded) return

  const denied = settingsPageDenial(to.path, roleFor(wid))
  if (denied) {
    useAdminToast().showToast(denied, 'error')
    return navigateTo(`/admin/${wid}/conversations`, { replace: true })
  }
})
