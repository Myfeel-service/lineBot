import { ADMIN_SIDEBAR_PAGE_SIZE } from '~~/app/composables/useAdminSidebarInfiniteList'

export type FlowModulePickerOption = {
  id: string
  name: string
  /**
   * `D-86`：讓共用的 AdminFlowPicker 標得出「還沒有內容／已停用」。
   * ⚠️ 這一頁載的是**完整**清單（側欄點一下就要直接編輯），所以直接數 `messages` 就好，
   *    不像別頁要靠 `/api/flow/list?fields=picker` 回的 `messageCount`。
   */
  isActive?: boolean
  messageCount?: number
}

/**
 * 機器人模組頁：一次載入完整清單，側邊欄客戶端分頁、選單共用同一份資料（避免重複打 list API）。
 */
export function useFlowWorkspaceList() {
  const { apiFetch } = useWorkspace()
  const allFlows = ref<any[]>([])
  const visibleRegularCount = ref(ADMIN_SIDEBAR_PAGE_SIZE)
  const loading = ref(false)
  const loadingMore = ref(false)
  const listEl = ref<HTMLElement | null>(null)

  const systemFlowsAll = computed(() => allFlows.value.filter((f) => f.isSystem))
  const regularFlowsAll = computed(() => allFlows.value.filter((f) => !f.isSystem))

  const flows = computed(() => [
    ...systemFlowsAll.value,
    ...regularFlowsAll.value.slice(0, visibleRegularCount.value),
  ])

  const hasMore = computed(() => regularFlowsAll.value.length > visibleRegularCount.value)

  const modulePickerOptions = computed<FlowModulePickerOption[]>(() =>
    allFlows.value.map(f => ({
      id: f.id,
      name: String(f.name || f.id),
      isActive: (f as Record<string, unknown>).isActive as boolean | undefined,
      messageCount: Array.isArray((f as Record<string, unknown>).messages)
        ? ((f as Record<string, unknown>).messages as unknown[]).length
        : undefined,
    })),
  )

  function resetVisibleRegularCount() {
    const systemCount = systemFlowsAll.value.length
    visibleRegularCount.value = Math.max(0, ADMIN_SIDEBAR_PAGE_SIZE - systemCount)
  }

  async function prefetchIfListDoesNotScroll() {
    await nextTick()
    const el = listEl.value
    if (!el || !hasMore.value || loading.value || loadingMore.value) return
    if (el.scrollHeight <= el.clientHeight + 1) {
      await loadMore()
      await prefetchIfListDoesNotScroll()
    }
  }

  async function load(reset = true) {
    if (reset) {
      if (loading.value) return
      loading.value = true
    }
    else {
      if (loadingMore.value || loading.value || !hasMore.value) return
      loadingMore.value = true
    }

    try {
      if (reset) {
        allFlows.value = await apiFetch<any[]>('/api/flow/list').catch(() => [])
        resetVisibleRegularCount()
        if (hasMore.value) await prefetchIfListDoesNotScroll()
      }
      else {
        visibleRegularCount.value += ADMIN_SIDEBAR_PAGE_SIZE
        if (hasMore.value) await prefetchIfListDoesNotScroll()
      }
    }
    catch {
      if (reset) allFlows.value = []
    }
    finally {
      loading.value = false
      loadingMore.value = false
    }
  }

  async function loadMore() {
    if (!hasMore.value || loading.value || loadingMore.value) return
    await load(false)
  }

  function onScroll() {
    const el = listEl.value
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80)
      void loadMore()
  }

  function setRegularFlowsOrder(nextRegular: any[]) {
    allFlows.value = [...systemFlowsAll.value, ...nextRegular]
  }

  /**
   * 讓某一個模組**出現在側欄上**（`D-86`：從 `?id=` 或別頁連過來時用）。
   *
   * ⛔ 側欄是分頁的（`visibleRegularCount`），排在第一頁之後的模組**根本沒有渲染出來**。
   *    不做這一步，深連結就會變成「右邊編輯器開了，左邊卻找不到反白的那一列」，
   *    人會以為自己開錯了東西。
   * ⚠️ 系統模組永遠在最上面、不受分頁影響，所以只要處理自建的那一段。
   */
  function ensureFlowVisible(id: string) {
    const index = regularFlowsAll.value.findIndex(f => f.id === id)
    if (index < 0) return // 系統模組、或這份清單裡沒有——都不用動
    if (index < visibleRegularCount.value) return
    // 多補到整頁，免得剛好卡在邊界、再捲一格又要載入
    const pages = Math.ceil((index + 1) / ADMIN_SIDEBAR_PAGE_SIZE)
    visibleRegularCount.value = pages * ADMIN_SIDEBAR_PAGE_SIZE
  }

  return {
    allFlows,
    flows,
    modulePickerOptions,
    loading,
    loadingMore,
    hasMore,
    listEl,
    load,
    loadMore,
    onScroll,
    setRegularFlowsOrder,
    ensureFlowVisible,
  }
}
