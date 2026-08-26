/**
 * 後台共用：載入好友列表（/api/users/list，伺服器分頁）
 */
export const ADMIN_USER_PAGE_SIZE = 50

export type AdminUserListQuery = {
  tagIds?: string[]
  search?: string
  /** 只看「有待處理 AI 標籤建議」的客人（收件匣入口） */
  suggested?: boolean
  page?: number
  limit?: number
}

/**
 * 組查詢字串。**抽成純函式是為了測得到**——`suggested` 這條就是因為
 * 「畫面傳了、composable 沒往下帶」而整個篩選是死的（2026-08-23 code review 抓到），
 * 而型別檢查抓不到（呼叫端不是字面物件，不吃 excess property check）。
 *
 * ⛔ 新增條件時**同時**改這裡與 `userListRequestKey`，兩支都有測試釘著。
 */
export function buildUserListParams(query?: AdminUserListQuery, defaultLimit = ADMIN_USER_PAGE_SIZE): URLSearchParams {
  const params = new URLSearchParams()
  if (query?.tagIds?.length) params.set('tagIds', query.tagIds.join(','))
  if (query?.search?.trim()) params.set('search', query.search.trim())
  if (query?.suggested) params.set('suggested', '1')
  params.set('page', String(query?.page ?? 1))
  params.set('limit', String(query?.limit ?? defaultLimit))
  return params
}

/**
 * 飛行中請求的去重鑰匙。每個會影響結果的條件都要在裡面：
 * 漏一個 → 「同頁同搜尋字、只切那個條件」時會命中同一支請求，畫面停在舊結果。
 */
export function userListRequestKey(query?: AdminUserListQuery, defaultLimit = ADMIN_USER_PAGE_SIZE): string {
  return JSON.stringify({
    tagIds: query?.tagIds ?? [],
    search: query?.search ?? '',
    suggested: query?.suggested ?? false,
    page: query?.page ?? 1,
    limit: query?.limit ?? defaultLimit,
  })
}

export function useAdminUserList() {
  const users = ref<any[]>([])
  const loading = ref(false)
  const total = ref(0)
  /** true＝後端掃描撞到上限，清單與總數可能不完整（要讓畫面講出來，別把「掃不完」顯示成「沒有」） */
  const truncated = ref(false)
  const page = ref(1)
  const pageSize = ref(ADMIN_USER_PAGE_SIZE)
  /**
   * 全工作區還有幾位客人的 AI 建議等人決定（頂端待辦條用）。
   * ⛔ 這個數字**不吃畫面上的篩選**——它回答「還有幾件事等你決定」，
   *    跟著篩選變小會讓人以為處理掉了。
   */
  const pendingSuggestionTotal = ref(0)
  const { apiFetch } = useWorkspace()

  let inFlight: { key: string; promise: Promise<boolean> } | null = null

  async function loadUsers(query?: AdminUserListQuery): Promise<boolean> {
    const key = userListRequestKey(query)
    if (inFlight && inFlight.key === key) return inFlight.promise

    const task = (async () => {
      loading.value = true
      try {
        const search = buildUserListParams(query, pageSize.value)

        const res = await apiFetch<{
          users: any[]
          total: number
          page: number
          limit: number
          truncated?: boolean
          pendingSuggestionTotal?: number
        }>(`/api/users/list?${search.toString()}`)

        users.value = res.users ?? []
        total.value = res.total ?? 0
        truncated.value = res.truncated === true
        pendingSuggestionTotal.value = res.pendingSuggestionTotal ?? 0
        page.value = res.page ?? query?.page ?? 1
        pageSize.value = res.limit ?? query?.limit ?? ADMIN_USER_PAGE_SIZE
        return true
      }
      catch {
        users.value = []
        total.value = 0
        truncated.value = false
        // ⛔ 載入失敗不要歸零：那會讓待辦條靜靜消失＝「查不到」被顯示成「沒有」
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

  return { users, loading, total, page, pageSize, truncated, pendingSuggestionTotal, loadUsers }
}
