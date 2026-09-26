import { can } from '~~/shared/permissions'

/**
 * 「設定 → LINE 通知」的門（`C-270`）：客服以上進得去（第 3 題拍板：客服可以加／退自己），
 * 跟其他設定頁（管理員才進得去，`workspace-settings`）刻意不同。直接輸入網址也擋。
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const wid = to.params.workspaceId as string | undefined
  if (!wid) return

  // 用 `to` 的 workspaceId 查角色，不要用 currentRole（守衛裡的 useRoute() 是舊路由）
  const { ensureWorkspaceList, roleFor } = useWorkspace()
  const { loaded } = await ensureWorkspaceList()
  if (!loaded) return

  if (!can(roleFor(wid), 'notify.self')) {
    useAdminToast().showToast('這一頁要客服以上的權限才能進入', 'error')
    return navigateTo(`/admin/${wid}/conversations`, { replace: true })
  }
})
