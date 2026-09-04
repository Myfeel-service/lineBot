/**
 * 「所屬產品」欄位的候選清單（這個帳號已經在用的產品名）。
 *
 * 匯入視窗與資料頁兩處都要用同一份清單。清單**存在模組層並且是同一個 ref**：
 * 各自持有一份的話，在資料 A 存了新產品名之後，同一個畫面上資料 B 的欄位還是舊清單，
 * 使用者就會再打一次同一台的第二種寫法——正是這個功能要防的事。
 *
 * 讀失敗一律當「沒有候選」處理，欄位退回純手打（這個清單是加分項，不能因為讀不到就填不了）；
 * 但**失敗與「真的一個都沒有」要分得出來**：呼叫端若拿「不在清單裡」當成「這是新產品」的證據，
 * 讀失敗會讓每一個產品都被標成新的（本專案在「查不到就等於沒問題」上踩過同一種雷）。
 */
type LoadStatus = 'idle' | 'loading' | 'ready' | 'failed'

interface ProductNameStore {
  names: Ref<string[]>
  /** 每個名字目前有幾張卡在用（`C-136`）；沒有這個 key ≠ 0 張，是「算不出來」 */
  usage: Ref<Record<string, number>>
  /** 曾經出現過的所有寫法（含已經合併掉的舊叫法）——用來判斷「這個名字是不是第一次出現」 */
  known: Ref<string[]>
  status: Ref<LoadStatus>
  expiresAt: number
}

const CACHE_TTL_MS = 60_000
const stores = new Map<string, ProductNameStore>()

function storeFor(workspaceId: string): ProductNameStore {
  let store = stores.get(workspaceId)
  if (!store) {
    store = {
      names: ref<string[]>([]),
      usage: ref<Record<string, number>>({}),
      known: ref<string[]>([]),
      status: ref<LoadStatus>('idle'),
      expiresAt: 0,
    }
    stores.set(workspaceId, store)
  }
  return store
}

export function useProductNames() {
  const { apiFetch, workspaceId } = useWorkspace()
  const wid = () => workspaceId.value ?? ''

  // computed 而非直接回 store.names：切換 workspace 時頁面元件會被沿用（只有路由參數變），
  // 綁死在 setup 當下那一份會留著上一個帳號的產品名
  const names = computed(() => storeFor(wid()).names.value)
  const known = computed(() => storeFor(wid()).known.value)
  const usage = computed(() => storeFor(wid()).usage.value)
  const status = computed(() => storeFor(wid()).status.value)
  /** 清單是不是真的讀到了（用來判斷「不在清單裡」能不能當成「這是新的」） */
  const ready = computed(() => status.value === 'ready')

  function invalidate() {
    storeFor(wid()).expiresAt = 0
  }

  async function load(force = false) {
    const store = storeFor(wid())
    if (!force && store.status.value === 'ready' && store.expiresAt > Date.now()) return
    store.status.value = 'loading'
    try {
      const res = await apiFetch<{ names: string[], known: string[], usage?: Record<string, number> }>('/api/ai/knowledge/product-names')
      store.names.value = Array.isArray(res?.names) ? res.names : []
      store.known.value = Array.isArray(res?.known) ? res.known : store.names.value
      store.usage.value = (res?.usage && typeof res.usage === 'object') ? res.usage : {}
      store.expiresAt = Date.now() + CACHE_TTL_MS
      store.status.value = 'ready'
    }
    catch {
      // 保留上一次讀到的清單（有總比沒有好），但狀態要標記失敗
      store.expiresAt = 0
      store.status.value = 'failed'
    }
  }

  /** 剛存了一個新產品名 → 兩處欄位都要立刻看得到它，下次載入再跟後端對齊 */
  function addLocal(name: string) {
    const clean = String(name || '').trim()
    if (!clean) return
    const store = storeFor(wid())
    store.expiresAt = 0
    if (!store.names.value.includes(clean)) {
      store.names.value = [...store.names.value, clean].sort((a, b) => a.localeCompare(b, 'zh-TW'))
    }
    if (!store.known.value.includes(clean)) store.known.value = [...store.known.value, clean]
  }

  return { names, known, usage, status, ready, load, invalidate, addLocal }
}
