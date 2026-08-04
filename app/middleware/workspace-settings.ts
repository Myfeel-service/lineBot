import { hasMinRole } from '~~/shared/permissions'

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

  const role = roleFor(wid)
  if (!role || !hasMinRole(role, 'admin')) {
    useAdminToast().showToast('這一頁只有管理員能進入', 'error')
    return navigateTo(`/admin/${wid}/conversations`, { replace: true })
  }
})
