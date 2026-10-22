import { lineQuotaLevel, type LineMessageQuota } from '~~/shared/line-quota'
import { useWorkspace } from './useWorkspace'

/**
 * 同一個帳號這麼久內不重問。換頁時每一頁的紅條都會叫一次 load，不擋的話每換一頁打一支；
 * 伺服器那邊也有 5 分鐘快取，所以這裡再短也拿不到更新的數字。
 */
const LINE_QUOTA_STALE_MS = 5 * 60_000

/**
 * LINE 這個月還剩幾則（`D-146`）：登入後第一頁那一條（`AdminLineQuotaStrip`）、用完時每一頁最上面的紅條
 * （`AdminLineQuotaBanner`）看同一份。推播頁自己另外問（剛送完要看到新的數字，`C-380`）。
 *
 * ⛔ 跟 `usePlanSummary` 同一個規矩：手上這份是**哪個帳號**的要記著，對不上一律當作沒有資料——
 *    紅條掛在版型上、換帳號不重掛，沒有戳記的話 B 家會先顯示 A 家「用完了」。
 * null＝還沒問到、沒接 LINE、或這次問不到（畫面整條不顯示）。
 */
export function useLineQuota() {
  const { apiFetch, workspaceId } = useWorkspace()
  const raw = useState<LineMessageQuota | null>('line-quota', () => null)
  const checkedFor = useState('line-quota-checked-for', () => '')
  const checkedAt = useState('line-quota-checked-at', () => 0)
  const shared = useSharedRequest('line-quota')

  const matchesWorkspace = computed(() => !!workspaceId.value && checkedFor.value === workspaceId.value)
  const quota = computed(() => (matchesWorkspace.value ? raw.value : null))
  const level = computed(() => lineQuotaLevel(quota.value))

  async function load(opts?: { force?: boolean }) {
    const wid = workspaceId.value ?? ''
    if (!wid)
      return
    if (!opts?.force && checkedFor.value === wid && Date.now() - checkedAt.value < LINE_QUOTA_STALE_MS)
      return
    const already = shared.pending(wid)
    if (already)
      return already
    return shared.start(wid, async (isLatest) => {
      let next: LineMessageQuota | null = null
      try {
        // 推播自己的端點只問這一格（`lineQuotaOnly`，同 `planOnly` 的做法：不讀推播清單）
        const res = await apiFetch<{ lineQuota?: LineMessageQuota | null }>('/api/broadcast/list', { params: { lineQuotaOnly: 1 } })
        next = res?.lineQuota ?? null
      }
      catch {
        next = null // 問不到＝不顯示（⛔ 不留上一份：可能是別家的、也可能已經過期）
      }
      if (!isLatest())
        return
      raw.value = next
      checkedFor.value = wid
      checkedAt.value = Date.now()
    })
  }

  return { quota, level, load }
}
