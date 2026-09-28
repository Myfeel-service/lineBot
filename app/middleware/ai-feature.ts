import type { WorkspaceMemberRole } from '~~/shared/types/organization'
import { CAPABILITIES, can, type Capability } from '~~/shared/permissions'

/**
 * AI 相關頁面的進入守門（2026-08 起依 capability 表逐頁把關，開發期 admin-only 閘門已拆）。
 *
 * 門檻讀 ~~/shared/permissions.ts 單一事實來源，與側欄選單顯示（default.vue 的
 * aiNavItems）、後端各 API 的 requireCapability 三處一致：
 *   - 知識庫 / 客服腳本 / AI 設定 → ai.read（viewer+，頁內寫入鈕另依 can() 隱藏）
 *   - 測試對話 → playground.use（agent+，會實際消耗 token）
 *   - AI 表現 → ai.read（viewer+；方案額度那張卡改由 API 逐欄位擋，admin+ 才拿得到）
 */
export function requiredCapability(path: string): Capability {
  if (path.includes('/ai-playground')) return 'playground.use'
  return 'ai.read'
}

const DENIED_MESSAGE: Partial<Record<Capability, string>> = {
  'playground.use': '測試對話只開放給客服（含）以上成員',
}

/**
 * 這個角色能不能待在這個 AI 頁；不能的話回要講給他聽的那句話，能就回 null。
 *
 * 抽出來是給 `auth.ts` 的背景重驗共用（`G-107` 第 21 條）：進頁時看的是上次存的帳號清單，
 * 被降級的人在清單更新前照樣進得來。⛔ 要判就呼叫這支，不要在別處再抄一份頁面→能力的對照。
 */
export function aiFeatureDenial(path: string, role: WorkspaceMemberRole | null): string | null {
  const capability = requiredCapability(path)
  if (can(role, capability)) return null
  // 不出聲地把人踢到別頁，他只會覺得「我明明點了 AI 設定，怎麼跑到對話去」。
  return DENIED_MESSAGE[capability]
    ?? `此頁面需要${CAPABILITIES[capability] === 'viewer' ? '工作區成員' : '更高'}權限`
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

  const denied = aiFeatureDenial(to.path, roleFor(wid))
  if (denied) {
    useAdminToast().showToast(denied, 'error')
    return navigateTo(`/admin/${wid}/conversations`, { replace: true })
  }
})
