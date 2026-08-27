import { derivePlanState, type PlanView } from '~~/shared/billing/plan-state'
import { useWorkspace } from './useWorkspace'

interface PlanSummaryResponse {
  plan: PlanView | null
  /** 本期（訂閱週期）已用則數 —— 與後端額度攔截看的是同一顆計數器。 */
  answered: number
}

/**
 * 抓「目前方案 + 本期已用則數」並導出額度使用狀態，供設定頁等處顯示精簡方案卡。
 * 與用量監控頁共用 derivePlanState（單一事實來源）；資料走輕量的 plan-summary 端點。
 *
 * 「本期」= 訂閱週期（錨定日制），不是日曆月。
 */
export function usePlanSummary() {
  const { apiFetch, workspaceId } = useWorkspace()

  // 全域共享：外殼的額度提醒條與頁內的方案卡看的是同一份數字，
  // 各自一份 ref 只會讓同一次載入問兩遍同一件事（見下方 inflight）。
  const rawPlan = useState<PlanView | null>('plan-summary-plan', () => null)
  const rawAnswered = useState('plan-summary-answered', () => 0)
  const loading = useState('plan-summary-loading', () => false)
  const rawLoaded = useState('plan-summary-loaded', () => false)
  /**
   * 手上這份方案是**哪個官方帳號**的。
   *
   * ⛔ 資料改成全域共享之後，這一欄就是必需品（同 `useSetupStatus` 的 `checkedFor`，
   * 那裡 2026-08-23 出過事）：外殼的額度條只載一次、之後換帳號不會重載，
   * 沒有戳記的話 B 家的方案頁在自己查回來之前會**照著顯示 A 家的方案名稱、
   * 本期起訖與已用則數**，而且升級視窗會帶著 A 家的 planId 進去。
   * 對不上就一律當作「還沒有資料」，不要把別家的答案端出來。
   */
  const checkedFor = useState('plan-summary-checked-for', () => '')

  /**
   * 同一瞬間只查一次（機制見 `useSharedRequest`）。
   *
   * ⛔ 呼叫端有兩種而且會同時發車：外殼的 `AdminQuotaBanner`（layout 內，每頁都在）
   * 與頁內的方案卡（AI 設定／組織與 LINE／方案與帳單）。原本兩邊各自 `ref`，
   * 所以那三頁每次載入都問兩遍 `plan-summary`（2026-08-27 正式站實測）。
   * ⚠️ 這裡刻意**不加時間節流**：翻頁與換帳號時要重新問（額度會變），
   * 只把「同一瞬間、同一個帳號」的重複請求收成一支。
   */
  const shared = useSharedRequest('plan-summary')

  const matchesWorkspace = computed(() =>
    !!workspaceId.value && checkedFor.value === workspaceId.value,
  )

  /** 對外一律走這幾個：對不上帳號就是「沒有資料」，不會顯示別家的方案 */
  const plan = computed(() => (matchesWorkspace.value ? rawPlan.value : null))
  const answered = computed(() => (matchesWorkspace.value ? rawAnswered.value : 0))
  const loaded = computed(() => matchesWorkspace.value && rawLoaded.value)

  const state = computed(() => derivePlanState(plan.value, answered.value))

  async function load() {
    const wid = workspaceId.value ?? ''
    const already = shared.pending(wid)
    if (already)
      return already

    loading.value = true
    return shared.start(wid, async (isLatest) => {
      try {
        const res = await apiFetch<PlanSummaryResponse>('/api/ai/usage/plan-summary')
        // 落地前確認自己還是最新那一支（切帳號時舊的那支不可以蓋掉新的答案）
        if (!isLatest())
          return
        rawPlan.value = res.plan
        rawAnswered.value = res.answered ?? 0
        checkedFor.value = wid
        rawLoaded.value = true
      }
      catch {
        if (!isLatest())
          return
        rawPlan.value = null
        rawAnswered.value = 0
        checkedFor.value = wid // 查失敗也是「這個帳號的結果」：畫面顯示沒有方案，不是別家的方案
        rawLoaded.value = true
      }
      finally {
        if (isLatest())
          loading.value = false
      }
    })
  }

  return { plan, answered, state, loading, loaded, load }
}
