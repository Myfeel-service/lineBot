/**
 * 後台共用：載入 Firestore 標籤列表（/api/tag/list）
 *
 * 重要：`loadTags` 只接受 `query` 物件，不要傳 workspaceId（已由 useWorkspace.apiFetch 自動帶入）。
 *   ✓ loadTags({ status: 'active' })
 *   ✗ loadTags(workspaceId.value, { status: 'active' })  // 第一個參數會被吃掉導致 status filter 失效
 */
export const ADMIN_TAG_PAGE_SIZE = 50

export type AdminTagListQuery = {
  status?: string
  category?: string
  /**
   * AI 判斷模式篩選：off / suggest / auto，或 `ai`＝suggest+auto 合起來。
   *
   * ⛔ 2026-08-26 修 bug：這一欄**本來根本沒有**——標籤頁的下拉有傳 `aiMode`，
   * 但這裡的型別沒宣告、組網址時也沒帶、連 in-flight 快取鍵都沒算它，
   * 所以「選了 AI 判斷、清單完全不變」。TypeScript 只對**字面物件**做多餘屬性檢查，
   * 呼叫端傳的是變數組出來的物件 → 編譯器全程沉默（同 `feedback_verify_new_code_actually_runs`）。
   * 加欄位的同時三處都要補：型別、URLSearchParams、快取鍵。
   */
  aiMode?: string
  search?: string
  includeMemberCount?: boolean
  page?: number
  limit?: number
}

/**
 * query 物件 → 網址參數（純函式，可測）。
 *
 * ⛔ **抽出來就是為了測得到**：2026-08-26 抓到「選了 AI 判斷、清單完全不變」——
 * 頁面有傳 `aiMode`，但這裡沒帶進網址，而 TypeScript 對「變數組出來的物件」
 * 不做多餘屬性檢查，所以編譯器全程沉默、測試也碰不到（同
 * `feedback_verify_new_code_actually_runs`：typecheck 綠 ≠ 新程式被執行過）。
 * 現在每加一個篩選條件，這支的測試會逼你把它帶進去。
 */
export function buildTagListParams(query?: AdminTagListQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query?.status) params.set('status', query.status)
  if (query?.category) params.set('category', query.category)
  if (query?.aiMode) params.set('aiMode', query.aiMode)
  if (query?.search?.trim()) params.set('search', query.search.trim())
  if (query?.includeMemberCount) params.set('includeMemberCount', '1')
  if (query?.page) {
    params.set('page', String(query.page))
    params.set('limit', String(query.limit ?? ADMIN_TAG_PAGE_SIZE))
  }
  return params
}

export function useAdminTagList() {
  const tags = ref<any[]>([])
  const loading = ref(false)
  const total = ref(0)
  /** 各分段的標籤數（給計數膠囊用）。⛔ 算的時候**排除 aiMode 這個條件本身**，
   *  否則點了「AI 判斷中」之後其他兩顆會全部歸零（分面篩選的通則）。 */
  const segments = ref<{ all: number, ai: number, manual: number, suggest: number, auto: number }>(
    { all: 0, ai: 0, manual: 0, suggest: 0, auto: 0 },
  )
  const page = ref(1)
  const pageSize = ref(ADMIN_TAG_PAGE_SIZE)
  const { apiFetch } = useWorkspace()

  let inFlight: { key: string; promise: Promise<boolean> } | null = null

  async function loadTags(query?: AdminTagListQuery): Promise<boolean> {
    const key = JSON.stringify({
      status: query?.status ?? '',
      category: query?.category ?? '',
      aiMode: query?.aiMode ?? '',
      search: query?.search ?? '',
      includeMemberCount: query?.includeMemberCount ? '1' : '0',
      page: query?.page ?? '',
      limit: query?.limit ?? '',
    })
    if (inFlight && inFlight.key === key) return inFlight.promise

    const task = (async () => {
      loading.value = true
      try {
        const search = buildTagListParams(
          query?.page ? { ...query, limit: query.limit ?? pageSize.value } : query,
        )

        const qs = search.toString() ? `?${search.toString()}` : ''
        const res = await apiFetch<any>(`/api/tag/list${qs}`)

        if (query?.page) {
          tags.value = res.items ?? []
          total.value = res.total ?? 0
          if (res.segments) segments.value = res.segments
          page.value = res.page ?? query.page
          pageSize.value = res.limit ?? query.limit ?? ADMIN_TAG_PAGE_SIZE
        }
        else {
          tags.value = Array.isArray(res) ? res : (res.items ?? [])
          total.value = tags.value.length
        }
        return true
      }
      catch {
        tags.value = []
        total.value = 0
        /**
         * ⛔ 計數也要歸零。只清清單不清數字的話，畫面會同時出現
         * 「全部 21 ｜ 🤖 AI 判斷中 3 ｜ 手動／系統 18」和一張空表格＋「符合 0 筆」
         * ——兩個互相矛盾的說法，而使用者分不出是「真的沒有」還是「剛才沒載到」
         * （同這一頁自己的「查不到≠沒問題」三態鐵律）。
         */
        segments.value = { all: 0, ai: 0, manual: 0, suggest: 0, auto: 0 }
        return false
      }
      finally {
        loading.value = false
        inFlight = null
      }
    })()
    inFlight = { key, promise: task }
    return task
  }

  return { tags, loading, total, segments, page, pageSize, loadTags }
}
