/**
 * 昨日摘要（小幫手的日報資料）。
 *
 * 刻意不開新端點、不發明新口徑：直接打對話統計的 KPI 端點
 * （/api/conversation-stats/kpi，昨天與前天各查一次）。同一支查詢、同一套
 * 首接/轉真人定義，小幫手講的數字和統計頁看到的永遠對得上——
 * 兩處口徑漂移是這個後台踩過最痛的坑（詳見 docs/CONVERSATION-STATS-DEFINITIONS.md）。
 */

import type { KpiResult } from '~~/shared/types/conversation-stats'

export interface DailyBriefDay {
  /** 客人對話場數（已排除客人沒開口的場） */
  total: number
  /** AI／機器人先回的場數（aiHandled + botHandled） */
  autoFirst: number
  /** 轉真人件數 */
  handoffs: number
  /** 整天都沒有人回的場數 */
  unhandled: number
}

export interface DailyBrief {
  /** 摘要對象日期（昨天），本地時間 YYYY-MM-DD */
  date: string
  yesterday: DailyBriefDay
  dayBefore: DailyBriefDay
  /**
   * 前 7 天（昨天不算，往前推 7 天）的每日平均，給「昨天是不是特別多」當基準。
   * 查不到＝null——趨勢就不下結論，日報本體照常。
   */
  baseline: { total: number; handoffs: number; unhandled: number } | null
}

/** 兩次抓取之間的最短間隔：昨天的數字不會變，開關面板不該重打 */
const REFRESH_TTL_MS = 10 * 60_000

function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function toDay(k: KpiResult): DailyBriefDay {
  return {
    total: k.total,
    autoFirst: k.aiHandled + k.botHandled,
    handoffs: k.handoffCount,
    unhandled: k.unhandled,
  }
}

export function useDailyBrief() {
  const { workspaceId, apiFetch } = useWorkspace()

  // 全域共享，開場白與摘要區塊共用同一份
  const brief = useState<DailyBrief | null>('daily-brief', () => null)
  const loaded = useState('daily-brief-loaded', () => false)
  const loading = useState('daily-brief-loading', () => false)
  const checkedAt = useState('daily-brief-checked-at', () => 0)

  let inflight: Promise<void> | null = null

  async function refresh(options: { force?: boolean } = {}): Promise<void> {
    if (!workspaceId.value)
      return
    if (inflight)
      return inflight

    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const dayBefore = new Date()
    dayBefore.setDate(dayBefore.getDate() - 2)
    const yStr = fmtDate(yesterday)

    // 節流；但跨日後（面板隔天才再打開）快取講的還是「前天」，一定要重抓
    const fresh = checkedAt.value && Date.now() - checkedAt.value < REFRESH_TTL_MS
    if (!options.force && fresh && brief.value?.date === yStr)
      return

    loading.value = true
    // 趨勢基準窗：昨天往前推 7 天（-8 ～ -2）
    const baseStart = new Date()
    baseStart.setDate(baseStart.getDate() - 8)
    const baseEnd = new Date()
    baseEnd.setDate(baseEnd.getDate() - 2)

    inflight = (async () => {
      try {
        const dStr = fmtDate(dayBefore)
        const [yk, dk, base] = await Promise.all([
          apiFetch<KpiResult>('/api/conversation-stats/kpi', { params: { startDate: yStr, endDate: yStr } }),
          apiFetch<KpiResult>('/api/conversation-stats/kpi', { params: { startDate: dStr, endDate: dStr } }),
          // 基準查失敗不拖垮日報本體：趨勢缺席比整份日報缺席無害
          apiFetch<KpiResult>('/api/conversation-stats/kpi', {
            params: { startDate: fmtDate(baseStart), endDate: fmtDate(baseEnd) },
          }).catch(() => null),
        ])
        brief.value = {
          date: yStr,
          yesterday: toDay(yk),
          dayBefore: toDay(dk),
          baseline: base
            ? { total: base.total / 7, handoffs: base.handoffCount / 7, unhandled: base.unhandled / 7 }
            : null,
        }
        checkedAt.value = Date.now()
        loaded.value = true
      }
      catch {
        // 靜默失敗，保留前一次結果；摘要缺席比錯誤數字無害
      }
      finally {
        loading.value = false
        inflight = null
      }
    })()
    return inflight
  }

  /** 換工作區一定要清：把 A 家的昨日數字留在 B 家畫面上會直接誤導人 */
  function reset() {
    brief.value = null
    loaded.value = false
    checkedAt.value = 0
  }

  return { brief, loaded, loading, refresh, reset }
}
