import type { WorkspaceMemberRole } from '~~/shared/types/organization'
import type { Capability } from '~~/shared/permissions'
import { can as canWithRole } from '~~/shared/permissions'
import { useWorkspaceApiFetch } from './useWorkspaceApiFetch'

export interface WorkspaceItem {
  workspaceId: string
  name: string
  role: WorkspaceMemberRole
  organizationId: string | null
  organizationName: string | null
  /** 精簡方案標籤（僅 owner/admin 角色、且已訂閱時由後端帶出，供帳號選單顯示）。 */
  plan?: { id: string; name: string } | null
}

interface OrgAdminEntry { id: string; name: string }

interface MyWorkspacesResponse {
  workspaces: WorkspaceItem[]
  orgAdminOf: OrgAdminEntry[]
}

/**
 * 「你有哪些官方帳號」的上一次答案，存在瀏覽器裡。
 *
 * 為什麼要存：這份清單是**畫面級的閘門**——`middleware/auth.ts` 沒等到它就什麼都不畫，
 * 實測這一支要 0.4～1.7 秒，而且它沒回來之前那一頁一支查詢都還沒發出去
 * （標籤頁的資料是第 3.2 秒才開始查的，見 docs/ADMIN-PERF-AUDIT-20260827.md）。
 * 開頁先用上次的答案把畫面長出來、同時在背景重新問一次，就省掉那段全白。
 *
 * ⛔ 這不是權限：每一支 API 在伺服器端都各自 `requireWorkspaceAccess`，
 *    這份快取只影響「畫面要不要先長出來」。用它放行也只是樂觀——背景那次問完，
 *    真的沒權限就照原本的規則把人送回帳號選擇頁。
 * ⛔ 一定要綁 uid：不同人共用同一台電腦時，不可以拿別人的帳號清單來渲染。
 */
const WORKSPACE_LIST_CACHE_KEY = 'workspace-list-cache-v1'

interface WorkspaceListCache {
  uid: string
  workspaces: WorkspaceItem[]
  orgAdminOf: OrgAdminEntry[]
  savedAt: number
}

function readWorkspaceListCache(uid: string): WorkspaceListCache | null {
  if (!import.meta.client || !uid) return null
  try {
    const raw = localStorage.getItem(WORKSPACE_LIST_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as WorkspaceListCache
    if (parsed?.uid !== uid || !Array.isArray(parsed.workspaces)) return null
    return parsed
  }
  catch {
    return null // 無痕模式／壞資料：當作沒有快取，照原本的流程等 API
  }
}

function writeWorkspaceListCache(cache: WorkspaceListCache) {
  if (!import.meta.client) return
  try {
    localStorage.setItem(WORKSPACE_LIST_CACHE_KEY, JSON.stringify(cache))
  }
  catch { /* 存不進去就算了，下次照舊等 API */ }
}

/** 登出時清掉：帳號清單含官方帳號名稱，不留在別人也會用的電腦上 */
export function clearWorkspaceListCache() {
  if (!import.meta.client) return
  try {
    localStorage.removeItem(WORKSPACE_LIST_CACHE_KEY)
  }
  catch { /* ignore */ }
}

/**
 * 提供目前作用中的 workspace 上下文，以及自動注入 auth token + workspaceId 的 fetch 工具。
 * workspaceId 來自路由參數 /admin/[workspaceId]/...
 */
export const useWorkspace = () => {
  const route = useRoute()

  const workspaceId = computed(() => route.params.workspaceId as string)

  const workspaceList = useState<WorkspaceItem[]>('workspace:list', () => [])
  const orgAdminOf = useState<OrgAdminEntry[]>('workspace:orgAdminOf', () => [])
  const currentRole = computed<WorkspaceMemberRole | null>(() => {
    const found = workspaceList.value.find(w => w.workspaceId === workspaceId.value)
    return found?.role ?? null
  })
  const currentWorkspaceName = computed(() => {
    const found = workspaceList.value.find(w => w.workspaceId === workspaceId.value)
    return found?.name ?? workspaceId.value
  })

  // ── Auth helpers ───────────────────────────────────────────────

  const { apiFetch, getBearer } = useWorkspaceApiFetch(() => workspaceId.value)

  // ── Load workspace list ────────────────────────────────────────
  // in-flight dedup：避免 layout + page 同時 onMounted 並行打 `/api/admin/workspaces/my`
  // 模組級單例：所有元件共用同一個進行中的 Promise
  const inFlight = useState<Promise<WorkspaceItem[]> | null>('workspace:loadInFlight', () => null)

  async function loadWorkspaceList(): Promise<WorkspaceItem[]> {
    if (inFlight.value) return inFlight.value
    const task = (async () => {
      try {
        const token = await getBearer()
        const res = await $fetch<MyWorkspacesResponse>('/api/admin/workspaces/my', {
          headers: { Authorization: `Bearer ${token}` },
        })
        workspaceList.value = res.workspaces
        orgAdminOf.value = res.orgAdminOf
        const uid = useAuth().user.value?.uid
        if (uid)
          writeWorkspaceListCache({ uid, workspaces: res.workspaces, orgAdminOf: res.orgAdminOf, savedAt: Date.now() })
        return res.workspaces
      }
      finally {
        inFlight.value = null
      }
    })()
    inFlight.value = task
    return task
  }

  /**
   * 給「路由守衛」用的載入：已經載過就不重打，而且**回報成功或失敗**。
   *
   * 守衛要用清單判斷「這個 workspace 你有沒有權限」，所以必須分得出
   * 「查過了、真的沒有」與「根本沒查到（斷網／token 過期）」——
   * 兩者混在一起的話，一次網路抖動就會把有權限的人踢出去。
   */
  async function ensureWorkspaceList(): Promise<{ loaded: boolean }> {
    if (workspaceList.value.length > 0) return { loaded: true }
    try {
      await loadWorkspaceList()
      return { loaded: true }
    }
    catch {
      return { loaded: false }
    }
  }

  /**
   * 拿上次的答案先把畫面長出來（只在還沒有清單時）。回傳有沒有真的填進去。
   *
   * 搭配 `middleware/auth.ts`：填得進去就先放行、背景重新驗證；填不進去（第一次登入、
   * 換帳號、無痕模式）就照原本的流程等 API 回來。
   * ⛔ 這裡**不做權限判斷**：填進去之後守衛還是會看 `roleFor`，而且背景那次問完會再看一次。
   */
  function hydrateWorkspaceListFromCache(): boolean {
    if (workspaceList.value.length > 0) return true
    const uid = useAuth().user.value?.uid
    if (!uid) return false
    const cached = readWorkspaceListCache(uid)
    if (!cached?.workspaces.length) return false
    workspaceList.value = cached.workspaces
    orgAdminOf.value = cached.orgAdminOf ?? []
    return true
  }

  /**
   * 指定 workspace 的角色（不是「目前路由」的）。
   *
   * 路由守衛裡 `useRoute()` 拿到的是**還沒切過去的舊路由**，用 currentRole 判斷
   * 會拿錯 workspace 的角色。守衛請一律用 `to.params.workspaceId` 呼叫這支。
   */
  function roleFor(wid: string | undefined | null): WorkspaceMemberRole | null {
    if (!wid) return null
    return workspaceList.value.find(w => w.workspaceId === wid)?.role ?? null
  }

  // ── Role check helpers ─────────────────────────────────────────
  // canManageSettings：成員、LINE 憑證等 workspace 設定
  // canOperate：客服營運（對話、模組、推播等）— 不含觀察者
  // canWrite：同 canManageSettings（保留舊名稱相容）

  const canManageSettings = computed(() => {
    const r = currentRole.value
    return r === 'owner' || r === 'admin'
  })

  const canOperate = computed(() => {
    const r = currentRole.value
    return r === 'owner' || r === 'admin' || r === 'agent'
  })

  const isViewer = computed(() => currentRole.value === 'viewer')

  const canWrite = canManageSettings

  const isOwner = computed(() => currentRole.value === 'owner')

  // 能力判斷：讀 ~~/shared/permissions.ts 的 CAPABILITIES，與後端 requireCapability 同一份表。
  // 用法：can('scripts.write')、can('ai.settings.write') …
  const can = (capability: Capability) => canWithRole(currentRole.value, capability)

  return {
    workspaceId,
    currentRole,
    currentWorkspaceName,
    workspaceList,
    orgAdminOf,
    canManageSettings,
    canOperate,
    isViewer,
    canWrite,
    isOwner,
    can,
    getBearer,
    apiFetch,
    loadWorkspaceList,
    ensureWorkspaceList,
    hydrateWorkspaceListFromCache,
    roleFor,
  }
}
