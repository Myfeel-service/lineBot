// 這些是「不綁 workspace」的 admin 路徑，第二段不是 workspaceId
// （org 也在內：/admin/org/[orgId] 是組織層頁面，orgId 不是 workspaceId）
const NON_WORKSPACE_SEGMENTS = new Set(['workspaces', 'super', 'onboarding', 'org'])

function workspaceIdFromAdminPath(path: string): string | undefined {
  const segments = path.split('/').filter(Boolean)
  if (segments[0] !== 'admin' || !segments[1]) return undefined
  if (NON_WORKSPACE_SEGMENTS.has(segments[1])) return undefined
  return segments[1]
}

export default defineNuxtRouteMiddleware(async (to) => {
  if (!to.path.startsWith('/admin')) return

  const { isLoggedIn, waitForAuthReady } = useAuth()
  await waitForAuthReady()

  if (!isLoggedIn.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }

  // 在 /admin（無 workspaceId）時，導向 workspace 選擇頁
  // /admin/super/* 交給 super-admin middleware 自行處理
  const workspaceId = (to.params.workspaceId as string | undefined)
    ?? workspaceIdFromAdminPath(to.path)
  if (
    !workspaceId
    && to.path !== '/admin/workspaces'
    && to.path !== '/admin/onboarding'
    && !to.path.startsWith('/admin/super')
    && !to.path.startsWith('/admin/org/')
  ) {
    return navigateTo('/admin/workspaces')
  }

  if (!workspaceId) return

  // ── 這個官方帳號到底是不是你的？────────────────────────────────────
  // 之前完全沒擋：把網址裡的 workspaceId 換成別人的，整個後台外殼、側欄、分頁照樣長出來，
  // 只是每支 API 都靜靜地 403 —— 畫面看起來像「這個帳號什麼資料都沒有」。
  // 對進來的人是誤會（以為自己看到了別人的帳號內容），對我們是說不清的客訴。
  //
  // 清單本身就是權威來源：super admin 拿到全部、org admin 拿到組織底下全部、
  // 被 email 邀請但還沒轉正的也在內（見 /api/admin/workspaces/my），比對清單就夠。
  const { ensureWorkspaceList, roleFor } = useWorkspace()
  const { loaded } = await ensureWorkspaceList()
  // 沒載成功（斷網／token 剛過期）→ 不下判斷，交給頁面自己的錯誤處理。
  // 否則一次網路抖動就會把有權限的人踢回帳號選擇頁。
  if (!loaded) return

  if (!roleFor(workspaceId)) {
    useAdminToast().showToast('你沒有這個官方帳號的權限，已回到帳號選擇頁', 'error')
    return navigateTo('/admin/workspaces', { replace: true })
  }
})
