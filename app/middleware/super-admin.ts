export default defineNuxtRouteMiddleware(async (to) => {
  const { user, waitForAuthReady } = useAuth()
  await waitForAuthReady()
  if (!user.value) return navigateTo({ path: '/login', query: { redirect: to.fullPath } })

  // getIdTokenResult() 過期時會去換新 token —— 換不到就**丟例外**（帳號被停用／權限
  // 被撤銷、refresh token 失效、網路不通都算）。在路由守衛裡丟例外 = Nuxt 直接顯示
  // 「500 Internal Server Error / Firebase: Error (auth/...)」，使用者只看到一個裸的
  // 500，不會知道其實只是登入狀態掉了。所以這裡自己接住，導回登入頁重來一次。
  let isSuper = false
  try {
    const tokenResult = await user.value.getIdTokenResult()
    isSuper = tokenResult.claims.superAdmin === true
  }
  catch {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }

  if (!isSuper) return navigateTo('/admin/workspaces')

  if (to.path === '/admin/super' || to.path === '/admin/super/') {
    return navigateTo('/admin/super/organizations', { replace: true })
  }
})
