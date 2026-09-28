import type { WorkspaceMemberRole } from '~~/shared/types/organization'
import { can } from '~~/shared/permissions'

/**
 * 這個角色進不進得了 LINE 通知頁；進不了回要講的那句話，進得了回 null。
 * 匯出給 `auth.ts` 的背景重驗用（`G-107` 第 21 條）：客服被降成觀察者時，停在這頁也要被請出去。
 */
export function notifyPageDenial(role: WorkspaceMemberRole | null): string | null {
  return can(role, 'notify.self') ? null : '這一頁要客服以上的權限才能進入'
}

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

  const denied = notifyPageDenial(roleFor(wid))
  if (denied) {
    useAdminToast().showToast(denied, 'error')
    return navigateTo(`/admin/${wid}/conversations`, { replace: true })
  }
})
