/**
 * 額度橫幅（AdminQuotaBanner）的那段說明，抽成純函式才測得到（元件裡的 computed 沒有測試守著）。
 * 方案頁（settings/billing）的「AI 已停止自動回覆」那格也吃這一支——同一件事只有一種說法。
 *
 * 兩種「停了」客人那邊一模一樣、給店家的要分得出來（`C-8`）：
 *   · 則數用完 → 講用了幾則、升級就恢復。
 *   · 這個月 AI 被叫太多次（則數還沒用完）→ 講被叫了幾次、大多答不出來、補知識才答得出來、下個月 1 號恢復。
 * 中間那句後果兩邊**一字不差**（`C-341` 全站對齊的那句：自動回應照常，只有需要 AI 回答的才轉真人）。
 */
import type { QuotaState } from '~~/shared/billing/plan-state'
import { AI_CALL_CEILING_REMEDY } from '~~/shared/billing/call-ceiling'
import { monthDayText } from '~~/shared/billing/dunning'
import { daysBetween } from '~~/shared/time'

/** 已經停了的後果句（橫幅、方案頁共用；⛔「自動回應」不是「自動回覆」，見 `D-82`） */
export const QUOTA_STOPPED_CONSEQUENCE = '自動回應仍正常運作，但需要 AI 回答的問題現在都會轉給真人客服。'

export interface QuotaBannerInput {
  /** derivePlanState 的狀態（看則數） */
  state: QuotaState
  used: number
  limit: number | null
  /** AI 因為這個月被叫太多次先停了、而則數還沒用完（usePlanSummary 的 pausedByCalls） */
  pausedByCalls: boolean
  /** 這個月 AI 被叫的次數（pausedByCalls 時才用得到） */
  calls?: number | null
}

/**
 * 要不要講「AI 被叫太多次而停」：撞到上限、而且則數**還沒**用完。則數也用完的話照「則數用完」那套講
 * （同後端判斷的先後：兩個都到講則數，見 server/utils/billing.ts resolveQuotaDecision）。
 */
export function isPausedByCalls(callCeiling: { hit: boolean } | null | undefined, state: QuotaState): boolean {
  return callCeiling?.hit === true && state !== 'over'
}

/** AI 被叫太多次而停的那段（方案頁那格單獨用這支） */
export function aiCallPausedText(calls: number | null | undefined): string {
  return `這個月 AI 被叫了 ${(calls ?? 0).toLocaleString()} 次、大多答不出來，先停下來了。${QUOTA_STOPPED_CONSEQUENCE}${AI_CALL_CEILING_REMEDY}`
}

// ⚠️ 文案要準確：額度用完時**規則與腳本照常運作**，只有「原本由 AI 接手回答」的訊息
//    才會改成轉真人（見 server/utils/ai-answer.ts 的 quota 護欄）。寫成「所有訊息都轉真人」
//    會誇大，而客戶一用就會發現不是那樣——嚇唬人換來的升級，換來的是不信任。
export function quotaBannerDesc(input: QuotaBannerInput): string {
  if (input.pausedByCalls) return aiCallPausedText(input.calls)
  const used = input.used.toLocaleString()
  const limit = input.limit?.toLocaleString() ?? ''
  if (input.state === 'over') return `本期 ${limit} 則已用完。${QUOTA_STOPPED_CONSEQUENCE}升級後立即恢復。`
  // `D-180`：**先講他賺到什麼，再講後果**。80% 是全站唯一一個能用他自己的數字
  // 證明「這東西有效」的時刻，原本整段話從頭到尾都在講他要失去什麼。
  // ⚠️ 用字要準：一則＝AI 出手處理一次客人提問（含反問澄清），⛔ 不可以講成
  //    「回了 N 個客人」——同一個客人問五題就是五則，那樣講是誇大。
  // ⛔ 整段只講「本期」：同一句裡混用「這個月」與「本期」＝同一件事兩種說法，
  //    而這個產品的一期是錨定日制、不是日曆月（同升級視窗那顆 ⓘ 要解釋的事）。
  return `本期 AI 已經幫你處理了 ${used} 次客人提問（額度 ${limit} 則）。`
    + `用完後需要 AI 回答的問題會改為轉給真人客服（自動回應不受影響）。`
}

/**
 * 照這一期到目前為止的速度，大約再幾天會用完。算不出來就回 null（⛔ 不要硬給一個數字）。
 *
 * 為什麼要這個：「只剩 10 則」對店家不構成時間感，「約 2 天後用完」才會讓人現在就處理。
 * ⛔ 資料太少不猜：才開張一天、或一則都還沒用，算出來的速度會亂跳，寫在紅字上就是誤導。
 */
export function daysUntilQuotaOut(input: {
  used: number
  limit: number | null
  /** 本期起日（YYYY-MM-DD） */
  periodStart: string | null | undefined
  /** 今天（YYYY-MM-DD，台北） */
  today: string
}): number | null {
  const { used, limit, periodStart, today } = input
  if (!limit || !periodStart || used <= 0) return null
  const remaining = limit - used
  if (remaining <= 0) return null
  // 起訖皆含當日：起日當天就是第 1 天（⛔ 不加 1 的話第一天會除以 0）
  const elapsed = daysBetween(periodStart, today) + 1
  if (elapsed < 2) return null // 只有一天的資料＝雜訊，不是速度
  const perDay = used / elapsed
  if (perDay <= 0) return null
  const days = Math.max(1, Math.ceil(remaining / perDay))
  // 算出一個月以上＝他其實用得很慢，這句話對他沒有意義（而且會讓人以為我們在催）
  return days > 30 ? null : days
}

/** 橫幅標題。`over`（含被叫太多次而停）一律講「已經停了」，不講還剩幾則。 */
export function quotaBannerTitle(input: {
  state: QuotaState
  pausedByCalls: boolean
  remaining: number | null
  /** `daysUntilQuotaOut` 的結果；null＝算不出來，標題就不接那半句 */
  daysLeft: number | null
}): string {
  if (input.pausedByCalls || input.state === 'over') return 'AI 已停止自動回覆'
  const head = `AI 回覆本期只剩 ${(input.remaining ?? 0).toLocaleString()} 則`
  return input.daysLeft == null ? head : `${head}，約 ${input.daysLeft} 天後用完`
}

/**
 * 已經停了的時候，補一句「什麼時候會自己好」（`D-180`）。
 *
 * ⛔ 不講的話他會以為壞了、或以為要永遠停。**會買的人不會因為這句話就不買**
 * （他的客人現在正在等，兩天是等不起的）；**不買的人會留下來**，下一期還有機會。
 * 藏著反而像在逼他。空字串＝不知道本期哪天結束（舊資料），那就不要瞎掰。
 */
export function quotaResetNotice(periodEnd: string | null | undefined): string {
  const end = String(periodEnd ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return ''
  // ⛔ 日期不可以直接黏在「本期」前面：「12 月 1 日本期結束」會被先讀成「日本」。
  //    把日期放進括號，念起來才是「本期結束後會自動恢復」。
  return `不升級的話，本期結束（${monthDayText(end)}）後會自動恢復。`
}
