import type { WorkspaceMemberRole } from '~~/shared/types/organization'
import { hasMinRole } from '~~/shared/permissions'

/**
 * 這個角色能不能待在這個設定頁；不能的話回要講給他聽的那句話，能就回 null。
 *
 * 抽出來是給 `auth.ts` 的背景重驗共用（`G-107` 第 21 條）：進頁時這道門看的是**上次存的
 * 帳號清單**，被降級的管理員在清單更新前照樣進得來。背景那次問完要用**同一把尺**再判一次，
 * ⛔ 不要在 auth.ts 另寫一份「設定頁要管理員」——兩份遲早對不上。
 */
export function settingsPageDenial(path: string, role: WorkspaceMemberRole | null): string | null {
  if (!path.includes('/settings/')) return null
  if (!role || !hasMinRole(role, 'admin')) return '這一頁只有管理員能進入'
  return null
}

/**
 * 設定頁（成員管理、組織與 LINE）僅 owner / admin 可進入，
 * 與後端 members.manage / line.manage（皆 admin）對齊；直接輸入網址也擋。
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
