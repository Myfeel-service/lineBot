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
 * 機器人模組頁：一次載入完整清單，側邊欄、選單共用同一份資料（避免重複打 list API）。
 *
 * `C-422`：側欄**不再分段畫**。資料夾早就改成畫完整清單（`C-419`），分段只剩卡住「未分類」那一段——
 * 要捲到整份清單最底才補、補出來的卻插在最上面看不到；拖曳、刪資料夾、新增後找模組又拿分段那份找，
 * 排在後面的就找不到（拖不回未分類、刪資料夾後從畫面上消失、新增完選到第一個）。
 * 清單本來就一次載完，分段省的只是畫幾列，換來四個 bug，不划算。
 */
export function useFlowWorkspaceList() {
  const { apiFetch } = useWorkspace()
  const allFlows = ref<any[]>([])
  const loading = ref(false)
  const listEl = ref<HTMLElement | null>(null)

  const systemFlowsAll = computed(() => allFlows.value.filter((f) => f.isSystem))

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

  async function load() {
    if (loading.value) return
    loading.value = true
    try {
      allFlows.value = await apiFetch<any[]>('/api/flow/list').catch(() => [])
    }
    finally {
      loading.value = false
    }
  }

  function setRegularFlowsOrder(nextRegular: any[]) {
    allFlows.value = [...systemFlowsAll.value, ...nextRegular]
  }

  return {
    allFlows,
    modulePickerOptions,
    loading,
    listEl,
    load,
    setRegularFlowsOrder,
  }
}
