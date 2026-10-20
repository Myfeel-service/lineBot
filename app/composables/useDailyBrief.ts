/**
 * 昨日摘要（小幫手的日報資料）。
 *
 * 刻意不開新端點、不發明新口徑：直接打對話統計的 KPI 端點
 * （/api/conversation-stats/kpi，摘要那段與比較那段各查一次）。同一支查詢、同一套
 * 首接/轉真人定義，小幫手講的數字和統計頁看到的永遠對得上——
 * 兩處口徑漂移是這個後台踩過最痛的坑（詳見 docs/CONVERSATION-STATS-DEFINITIONS.md）。
 */

import { taipeiDateKey } from '~~/shared/taipei-day'
import { addDays, daysBetween } from '~~/shared/time'
import type { KpiResult } from '~~/shared/types/conversation-stats'

/**
 * 一天的摘要。
 *
 * ⚠️ 這裡有**兩種不同的數字**，UI 不可以把它們並排：
 * - `autoFirst` / `humanFirst` / `unhandled` 是「第一句話誰回的」的互斥分項，
 *   三個加起來等於 `total`（initialHandler 只會是其中一種）。
 * - `handoffs` 是「後來有沒有轉真人」，是 `total` 的**子集**，會與前面重疊
 *   （機器人先回、後來轉真人的同一場會同時算進 autoFirst 和 handoffs）。
 *
 * 之前三格並排（總數／AI先回／轉真人）就是因為混用這兩種，讀的人會去相加、
 * 對不起來，然後懷疑數字有 bug。加得起來的才能並排。
 */
export interface DailyBriefDay {
  /** 客人對話場數（已排除客人沒開口的場） */
  total: number
  /** AI／機器人先回的場數（aiHandled + botHandled） */
  autoFirst: number
  /** 客服自己先回的場數（humanHandled） */
  humanFirst: number
  /** 轉真人件數；**與上面兩項重疊**，不是第三類 */
  handoffs: number
  /** 整天都沒有人回的場數 */
  unhandled: number
  /** 第一次加好友的人數；-1＝查不到（老闆拍板 2026-08-07：只要人數，不帶「其中幾位開口」） */
  newFriends: number
  /** 沒人回的名單樣本（≤3，同一批 session 取樣）；點名字直接開那場對話 */
  unhandledSamples: { userId: string; displayName: string }[]
  /** 轉真人後等超過 SLA 的場數（門檻= handoffWaitSlaMinutes，沿用工作區 SLA 設定） */
  handoffWaitExceeded: number
  handoffWaitSlaMinutes: number
  /** 其中「轉真人那一刻已經下班」的場數；服務時間沒啟用時恆 0 */
  handoffWaitOffHours: number
  handoffWaitSamples: { userId: string; displayName: string }[]
}

export interface DailyBrief {
  /** 摘要講的最後一天（永遠是昨天，台北 YYYY-MM-DD）；拿來判斷快取是不是隔天了 */
  date: string
  /**
   * 摘要講的第一天（`D-137`①）。平常＝`date`；休假日之後的第一個上班日＝上一則 LINE 摘要之後的
   * 第一天（週一＝週五）。⛔ 跟 LINE 那則同一支規則（後端 `window=digest`），兩邊才講同一段。
   */
  startDate: string
  /** 講幾天（1＝昨天） */
  days: number
  /** 那幾天加起來（欄位名沿用：單日時就是昨天） */
  yesterday: DailyBriefDay
  /** 比較用：單日＝前天；好幾天＝上週同一段（週五～週日比上週五～週日，平日跟週末不混著比） */
  dayBefore: DailyBriefDay
  /**
   * 第一天之前 7 天的**每日**平均，給「這段是不是特別多」當基準（用的時候乘上天數）。
   * 查不到＝null——趨勢就不下結論，日報本體照常。
   */
  baseline: { total: number; handoffs: number; unhandled: number } | null
}

/** 兩次抓取之間的最短間隔：昨天的數字不會變，開關面板不該重打 */
const REFRESH_TTL_MS = 10 * 60_000

const DAY_MS = 24 * 3600_000

/**
 * 「N 天前」的台北日期字串。
 *
 * ⛔ 不可以用瀏覽器本機時區算（原本是 `new Date()` + `getFullYear/getMonth/getDate`）：
 * 後端一律把 `YYYY-MM-DD` 當**台北**日界線解讀（見 `shared/taipei-day.ts` 檔頭），
 * 而人在國外開後台時本機日期跟台北差一天——「昨日摘要」會提早或延後一整天切換，
 * 老闆在時差地看到的「昨天」跟台灣同事看到的不是同一天。
 * 兩邊用同一支 `taipeiDateKey` 就不會有第二把尺。
 */
function taipeiDaysAgo(days: number): string {
  return taipeiDateKey(new Date(Date.now() - days * DAY_MS))
}

function toDay(k: KpiResult): DailyBriefDay {
  return {
    total: k.total,
    autoFirst: k.aiHandled + k.botHandled,
    humanFirst: k.humanHandled,
    handoffs: k.handoffCount,
    unhandled: k.unhandled,
    newFriends: k.newFriends ?? -1,
    unhandledSamples: k.unhandledSamples ?? [],
    handoffWaitExceeded: k.handoffWaitExceeded ?? 0,
    handoffWaitSlaMinutes: k.handoffWaitSlaMinutes ?? 30,
    handoffWaitOffHours: k.handoffWaitOffHours ?? 0,
    handoffWaitSamples: k.handoffWaitSamples ?? [],
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

    const yStr = taipeiDaysAgo(1)

    // 節流；但跨日後（面板隔天才再打開）快取講的還是「前天」，一定要重抓
    const fresh = checkedAt.value && Date.now() - checkedAt.value < REFRESH_TTL_MS
    if (!options.force && fresh && brief.value?.date === yStr)
      return

    loading.value = true

    inflight = (async () => {
      try {
        // 先問後端這次講哪幾天（照每日摘要的規則，`D-137`①）：要看服務時間的週末／國定假日設定，
        // 那份設定前端這裡沒有，所以區間由後端推、跟著數字一起回來
        const yk = await apiFetch<KpiResult>('/api/conversation-stats/kpi', { params: { window: 'digest' } })
        const start = yk.rangeStart ?? yStr
        const end = yk.rangeEnd ?? yStr
        const days = daysBetween(start, end) + 1
        // 比較：單日照舊比前天；好幾天比上週同一段——週末比週末，跟平日比會永遠「比較少」
        const compare = days > 1
          ? { startDate: addDays(start, -7), endDate: addDays(end, -7) }
          : { startDate: addDays(start, -1), endDate: addDays(start, -1) }
        const [dk, base] = await Promise.all([
          apiFetch<KpiResult>('/api/conversation-stats/kpi', { params: compare }),
          // 基準查失敗不拖垮日報本體：趨勢缺席比整份日報缺席無害
          // 趨勢基準窗＝第一天往前推 7 天（單日時就是原本的 -8 ～ -2）
          apiFetch<KpiResult>('/api/conversation-stats/kpi', {
            params: { startDate: addDays(start, -7), endDate: addDays(start, -1) },
          }).catch(() => null),
        ])
        brief.value = {
          date: end,
          startDate: start,
          days,
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
