import type { RouteLocationNormalizedLoaded } from 'vue-router'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'
import { aiFeatureDenial } from './ai-feature'
import { settingsPageDenial } from './workspace-settings'
import { notifyPageDenial } from './workspace-notify'

// 這些是「不綁 workspace」的 admin 路徑，第二段不是 workspaceId
// （org 也在內：/admin/org/[orgId] 是組織層頁面，orgId 不是 workspaceId）
const NON_WORKSPACE_SEGMENTS = new Set(['workspaces', 'super', 'onboarding', 'org'])

/**
 * 這一頁掛了哪幾道「看角色」的門，用新的角色逐道再判一次（`G-107` 第 21 條，背景重驗用）。
 * 回要講給他聽的那句話；都過就回 null。
 *
 * ⛔ 看的是頁面自己在 `definePageMeta` 宣告的 middleware，不是看網址猜：
 *    `settings/line-notify` 網址也在 /settings/ 底下，但它掛的是 `workspace-notify`（客服就進得去），
 *    照網址判會把客服誤踢出去。
 */
function routeRoleDenial(route: RouteLocationNormalizedLoaded, role: WorkspaceMemberRole): string | null {
  const declared = route.meta.middleware
  // 具名的才算（inline 函式型的 middleware 沒有名字可比）
  const names: string[] = []
  for (const m of Array.isArray(declared) ? declared : [declared]) {
    if (typeof m === 'string') names.push(m)
  }
  if (names.includes('workspace-settings')) {
    const denied = settingsPageDenial(route.path, role)
    if (denied) return denied
  }
  if (names.includes('ai-feature')) {
    const denied = aiFeatureDenial(route.path, role)
    if (denied) return denied
  }
  if (names.includes('workspace-notify')) {
    const denied = notifyPageDenial(role)
    if (denied) return denied
  }
  return null
}

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
  const { ensureWorkspaceList, hydrateWorkspaceListFromCache, loadWorkspaceList, roleFor } = useWorkspace()

  /**
   * 先用上次的答案放行（`E-27`）。
   *
   * 為什麼：這道閘門擋的是**整個畫面**——實測那支要 0.4～1.7 秒，而且它沒回來之前
   * 這一頁一支查詢都還沒發出去（標籤頁的資料是第 3.2 秒才開始查的）。開頁先用瀏覽器裡
   * 上次的清單把畫面長出來，同時在背景重新問一次，把那段全白省掉。
   *
   * ⛔ 安全性不變：每一支 API 在伺服器端都各自 `requireWorkspaceAccess`，這道只是畫面上的
   *    體貼（它原本要擋的是「把網址換成別人的帳號、整個外殼照長出來」那種誤會）。
   * ⛔ 只有「上次的清單說你有這個帳號」才樂觀放行。上次說沒有＝可能是剛被邀請進來，
   *    那就照原本的流程等 API，不能拿舊答案把人擋在外面。
   */
  if (hydrateWorkspaceListFromCache() && roleFor(workspaceId)) {
    const router = useRouter()
    // 背景重新驗證：真的被移除權限了還是要照原本的規則送回帳號選擇頁
    void loadWorkspaceList()
      .then(() => {
        const role = roleFor(workspaceId)
        if (!role) {
          useAdminToast().showToast('你沒有這個官方帳號的權限，已回到帳號選擇頁', 'error')
          void navigateTo('/admin/workspaces', { replace: true })
          return
        }
        /**
         * 帳號還在、但**角色掉了**（`G-107` 第 21 條）：管理員被降成客服，上次存的清單還寫著
         * 管理員，設定頁的門（`workspace-settings`）就放他進來，按下去才 403。
         * 用新清單照那一頁自己的門再判一次，判法直接呼叫那兩道門匯出的函式（⛔ 不在這裡抄一份）。
         *
         * ⛔ 只管「現在還停在這一頁」的情況：清單回來前他可能已經走了，那一趟導航有自己的一次重驗，
         *    這裡再把他拉走就是亂跳。
         */
        const current = router.currentRoute.value
        if (current.fullPath !== to.fullPath) return
        const denied = routeRoleDenial(current, role)
        if (!denied) return
        useAdminToast().showToast(denied, 'error')
        void navigateTo(`/admin/${workspaceId}/conversations`, { replace: true })
      })
      .catch(() => { /* 斷網／token 過期：不下判斷，交給頁面自己的錯誤處理 */ })
    return
  }

  const { loaded } = await ensureWorkspaceList()
  // 沒載成功（斷網／token 剛過期）→ 不下判斷，交給頁面自己的錯誤處理。
  // 否則一次網路抖動就會把有權限的人踢回帳號選擇頁。
  if (!loaded) return

  if (!roleFor(workspaceId)) {
    useAdminToast().showToast('你沒有這個官方帳號的權限，已回到帳號選擇頁', 'error')
    return navigateTo('/admin/workspaces', { replace: true })
  }
})
