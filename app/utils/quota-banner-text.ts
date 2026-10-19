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
  return `本期已用 ${used} / ${limit} 則。用完後需要 AI 回答的問題會改為轉給真人客服（自動回應不受影響）。`
}
