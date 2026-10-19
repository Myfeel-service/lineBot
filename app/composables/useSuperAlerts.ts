/**
 * 超管「全站異常總覽」資料層（C-91）。
 *
 * 兩個吃的地方：超管側欄的紅點（layout 掛載時抓）＋總覽頁本體——同一份 useState，
 * 不各打各的。⛔連 inflight 閂都要放共用狀態：宣告在函式內的 `let` 是每個呼叫端
 * 各一份，兩個呼叫端同 tick 發車會把最貴的全租戶掃描打兩遍（E-20 的教訓）。
 *
 * 端點本身有 5 分鐘整包快取，這裡的 60 秒 TTL 只是省 HTTP 往返。
 */
import { pastDueAccountCount, superAlertsNav } from '~~/shared/super-alerts-nav'
import type { SuperAlertsOverviewPayload } from '~~/shared/types/super-alerts'

const REFRESH_TTL_MS = 60_000

export function useSuperAlerts() {
  const data = useState<SuperAlertsOverviewPayload | null>('super-alerts:data', () => null)
  const loading = useState<boolean>('super-alerts:loading', () => false)
  const error = useState<string | null>('super-alerts:error', () => null)
  const checkedAt = useState<number>('super-alerts:checked-at', () => 0)
  const inflight = useState<Promise<void> | null>('super-alerts:inflight', () => null)
  const { apiFetch } = useSuperAdmin()

  async function refresh(options: { force?: boolean } = {}): Promise<void> {
    if (inflight.value) return inflight.value
    if (!options.force && checkedAt.value && Date.now() - checkedAt.value < REFRESH_TTL_MS) return

    loading.value = true
    const task = (async () => {
      try {
        data.value = await apiFetch<SuperAlertsOverviewPayload>(
          `/api/admin/super/alerts-overview${options.force ? '?force=1' : ''}`,
        )
        checkedAt.value = Date.now()
        error.value = null
      }
      catch (e) {
        error.value = (e as { data?: { statusMessage?: string } })?.data?.statusMessage ?? '讀取失敗'
      }
      finally {
        loading.value = false
        inflight.value = null
      }
    })()
    inflight.value = task
    return task
  }

  /** 側欄點的等級與滑上去那句（判定在 shared/super-alerts-nav.ts，有單元測試） */
  const nav = computed(() => superAlertsNav(data.value))
  const navSeverity = computed(() => nav.value.severity)
  const navTip = computed(() => nav.value.tip)

  /**
   * 側欄「潛在客戶名單」的琥珀點（D-43②）：有還沒回覆的新名單就亮。
   * 用琥珀不用紅——是「有客戶在等你回」不是「東西壞了」；null（查不到）不亮，
   * 同側欄點三規則：查不到不畫點也不畫綠，誠實狀態在總覽頁講。
   */
  const leadsDotCount = computed<number>(() => {
    const n = data.value?.newLeads
    return typeof n === 'number' && n > 0 ? n : 0
  })

  /**
   * 側欄「金流總覽」的紅點（`B-43`②）：有帳號自動扣款失敗、還在寬限期。
   * 判定跟「異常總覽」那顆點同一支（shared/super-alerts-nav.ts），查不到不亮。
   */
  const pastDueDotCount = computed<number>(() => pastDueAccountCount(data.value))

  return { data, loading, error, checkedAt, refresh, navSeverity, navTip, leadsDotCount, pastDueDotCount }
}
