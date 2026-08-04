import { hasMinRole } from '~~/shared/permissions'

/**
 * AI 相關頁面的進入守門。
 *
 * 開發期：整片 AI 暫時只給 admin+（與後端 server/middleware/ai-feature-gate.ts 一致）。
 * 未來開放給 agent/viewer 時，把角色判斷放寬即可（改回只擋未登入，讓各 API 的
 * requireCapability 做細緻把關）。
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const { user, waitForAuthReady } = useAuth()
  await waitForAuthReady()
  if (!user.value) return navigateTo({ path: '/login', query: { redirect: to.fullPath } })

  const wid = to.params.workspaceId as string | undefined
  if (!wid) return

  // 角色一律用 `to` 的 workspaceId 去查：守衛裡的 useRoute() 拿到的還是**舊路由**，
  // 用 currentRole 會查成上一頁那個 workspace 的角色（跨帳號跳頁時就會誤判）。
  const { ensureWorkspaceList, roleFor } = useWorkspace()
  const { loaded } = await ensureWorkspaceList()
  if (!loaded) return

  const role = roleFor(wid)
  if (!role || !hasMinRole(role, 'admin')) {
    // 不出聲地把人踢到別頁，他只會覺得「我明明點了 AI 設定，怎麼跑到對話去」。
    useAdminToast().showToast('AI 客服相關頁面目前只開放給管理員', 'error')
    return navigateTo(`/admin/${wid}/conversations`, { replace: true })
  }
})
