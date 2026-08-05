import { CAPABILITIES, can, type Capability } from '~~/shared/permissions'

/**
 * AI 相關頁面的進入守門（2026-08 起依 capability 表逐頁把關，開發期 admin-only 閘門已拆）。
 *
 * 門檻讀 ~~/shared/permissions.ts 單一事實來源，與側欄選單顯示（default.vue 的
 * aiNavItems）、後端各 API 的 requireCapability 三處一致：
 *   - 知識庫 / 客服腳本 / AI 設定 → ai.read（viewer+，頁內寫入鈕另依 can() 隱藏）
 *   - 測試對話 → playground.use（agent+，會實際消耗 token）
 *   - 用量監控 → usage.read（admin，含方案額度等計費資訊）
 */
function requiredCapability(path: string): Capability {
  if (path.includes('/ai-usage')) return 'usage.read'
  if (path.includes('/ai-playground')) return 'playground.use'
  return 'ai.read'
}

const DENIED_MESSAGE: Partial<Record<Capability, string>> = {
  'usage.read': '用量監控只開放給管理員',
  'playground.use': '測試對話只開放給客服（含）以上成員',
}

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

  const capability = requiredCapability(to.path)
  const role = roleFor(wid)
  if (!can(role, capability)) {
    // 不出聲地把人踢到別頁，他只會覺得「我明明點了 AI 設定，怎麼跑到對話去」。
    const message = DENIED_MESSAGE[capability]
      ?? `此頁面需要${CAPABILITIES[capability] === 'viewer' ? '工作區成員' : '更高'}權限`
    useAdminToast().showToast(message, 'error')
    return navigateTo(`/admin/${wid}/conversations`, { replace: true })
  }
})
