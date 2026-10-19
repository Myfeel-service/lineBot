// ═══════════════════════════════════════════════════════════════════
//  自動扣款失敗之後的「期限」與「清單」（純函式，前後端共用；`B-16`／`B-43`②）
//
//  寬限期規則本身在 period.ts（GRACE_DAYS、rollSubscriptionToCurrentPeriod 的第 ④ 步），
//  這裡只負責把同一把尺**講成人看得懂的日期**——扣款失敗信、帳單頁的黃色警示、
//  超管的扣款失敗清單都讀這一支，三個地方講的「哪天降級」才會是同一天。
// ═══════════════════════════════════════════════════════════════════

import { addDays } from '../time'
import { GRACE_DAYS, type RolledSubscription } from './period'
import { getBillingPlan, isSelfServePaidPlan, type BillingPlanId, type WorkspaceSubscription } from './plans'

/**
 * 扣款失敗那一期的期限。
 *
 * `periodStart` = past_due 那一期的起日（續扣日）。降級的判定是
 * `addDays(periodStart, GRACE_DAYS) < today`（period.ts ④），所以：
 *   · `lastDay`     ＝最後一天還有機會扣到（這天的排程仍會再扣一次）
 *   · `downgradeOn` ＝這天起降回免費方案
 * ⛔ 不要在別處自己加減天數：period.ts 的比較改了，這裡跟著對；各算各的就會「信說 23 日、實際 22 日降」。
 */
export function graceDeadline(periodStart: string): { lastDay: string, downgradeOn: string } {
  const lastDay = addDays(periodStart, GRACE_DAYS)
  return { lastDay, downgradeOn: addDays(lastDay, 1) }
}

/**
 * 金流回的失敗原因講給店家聽（帳單頁、店家的扣款失敗提醒共用；超管清單看原文不經過這裡）。
 * PAYUNi 的「授權失敗」對一般人不好懂 → 補白話；其餘（金額不符…）已夠白話，原樣。
 */
// ⛔ 句子裡不放括號：店家 LINE 異常推播會把它整句包進「（…）」，括號套括號很難讀
const CHARGE_ERROR_PLAIN: Record<string, string> = {
  授權失敗: '卡片沒通過，銀行沒有核准這筆交易',
}
export function plainChargeError(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim()
  return CHARGE_ERROR_PLAIN[s] ?? s
}

/** `2026-10-23` → `10 月 23 日`（信件與帳單頁講期限用；年份同年不必講）。 */
export function monthDayText(ymd: string): string {
  const m = Number(ymd.slice(5, 7))
  const d = Number(ymd.slice(8, 10))
  if (!m || !d) return ymd
  return `${m} 月 ${d} 日`
}

/**
 * 這次降級是不是「錢一直沒扣到」造成的（`B-16`：要寄「已降回免費」、要進超管清單）。
 *
 * 降級有三種來源（period.ts）：①客戶按了取消 ②沒有約定卡（到期直接降） ③有約定卡、自動續訂中，
 * 但寬限期滿還沒扣到。只有 ③ 是「扣款失敗」——①是客戶自己要的、②已有綁卡提醒信。
 * 判斷看**降級前**的樣子：自動續訂、沒按取消、有卡、付費方案 → roll 一定先進 past_due，
 * 所以會被降只可能是寬限期滿。
 */
export function isNonPaymentDowngrade(before: WorkspaceSubscription, rolled: RolledSubscription): boolean {
  return rolled.downgraded
    && before.autoRenew === true
    && before.cancelAtPeriodEnd !== true
    && Boolean(before.payuniCardToken)
    && isSelfServePaidPlan(before.planId)
}

/** 超管扣款失敗清單：降回免費之後還留在清單上幾天（讓人看得到「上週有誰因為卡被降」）。 */
export const RECENT_DOWNGRADE_DAYS = 14

/** 超管「扣款失敗」清單的一列（金流工作台＋異常總覽共用）。 */
export interface DunningRow {
  workspaceId: string
  workspaceName: string
  /** past_due＝扣款失敗、還在寬限期（服務照跑）；downgraded＝寬限期滿、已降回免費 */
  state: 'past_due' | 'downgraded'
  /** 扣款失敗的那個方案（已降級的列＝降級前的方案） */
  planId: BillingPlanId
  planName: string
  /** 金流回的失敗原因；null＝這期還沒扣過（排程還沒輪到，或結果未定在等查單） */
  lastChargeError: string | null
  /** 這期試扣過幾次 */
  attempts: number
  /** 最後一次試扣的日期 */
  lastChargeDate: string | null
  /** 寬限期最後一天（還在寬限期的列才有） */
  graceLastDay: string | null
  /** 降回免費的那天：還在寬限期＝預定；已降級＝實際那天 */
  downgradeOn: string | null
  /** 扣款卡末四碼 */
  cardLast4: string | null
  /**
   * 通知客戶的信：還在寬限期＝扣款失敗信；已降級＝「已降回免費」信。
   * sent＝寄出去了；pending＝還沒寄成功（寄失敗在重試，或 SES 沒設定）；no_recipient＝找不到帳務信箱、寄不了；
   * null＝不適用（這期還沒扣失敗過，不會有失敗信）
   */
  email: 'sent' | 'pending' | 'no_recipient' | null
}

/**
 * 由一個帳號的訂閱組出清單的一列；不在清單上的回 null。純函式，讀取端（超管兩頁）共用。
 * `today` 是台北日期。
 */
export function buildDunningRow(
  workspaceId: string,
  workspaceName: string,
  sub: WorkspaceSubscription | null | undefined,
  today: string,
): DunningRow | null {
  if (!sub) return null

  // ① 扣款失敗、還在寬限期（或寬限期剛過、對帳還沒把降級寫回去——畫面照實講「已降」）
  if (sub.status === 'past_due' && isSelfServePaidPlan(sub.planId) && sub.currentPeriodStart) {
    const { lastDay, downgradeOn } = graceDeadline(sub.currentPeriodStart)
    const samePeriod = sub.chargePeriodStart === sub.currentPeriodStart
    const attempts = samePeriod ? (sub.chargeAttempts ?? 0) : 0
    const error = samePeriod ? (String(sub.lastChargeError ?? '').trim() || null) : null
    const expired = lastDay < today
    return {
      workspaceId,
      workspaceName,
      state: expired ? 'downgraded' : 'past_due',
      planId: sub.planId,
      planName: getBillingPlan(sub.planId).name,
      lastChargeError: error,
      attempts,
      lastChargeDate: samePeriod ? (sub.lastChargeDate ?? null) : null,
      graceLastDay: expired ? null : lastDay,
      downgradeOn,
      cardLast4: sub.payuniCardLast4 ?? null,
      email: !error
        ? null
        : sub.chargeFailedEmailSentFor !== sub.currentPeriodStart
          ? 'pending'
          : sub.chargeFailedEmailNoRecipientFor === sub.currentPeriodStart ? 'no_recipient' : 'sent',
    }
  }

  // ② 近幾天因為扣不到款被降回免費（降級時寫下的紀錄）。已經重新付費的不算（方案已不是免費）
  const np = sub.nonPaymentDowngrade
  if (np?.on && np.on >= addDays(today, -RECENT_DOWNGRADE_DAYS) && !isSelfServePaidPlan(sub.planId)) {
    return {
      workspaceId,
      workspaceName,
      state: 'downgraded',
      planId: np.fromPlanId,
      planName: getBillingPlan(np.fromPlanId).name,
      lastChargeError: String(sub.lastChargeError ?? '').trim() || null,
      attempts: sub.chargeAttempts ?? 0,
      lastChargeDate: sub.lastChargeDate ?? null,
      graceLastDay: null,
      downgradeOn: np.on,
      cardLast4: sub.payuniCardLast4 ?? null,
      email: np.emailSent !== true ? 'pending' : np.noRecipient ? 'no_recipient' : 'sent',
    }
  }
  return null
}

/** 清單排序：還在寬限期的在前（最快到期的最前面），已降級的在後（最近的在前）。 */
export function sortDunningRows(rows: DunningRow[]): DunningRow[] {
  return [...rows].sort((a, b) => {
    if (a.state !== b.state) return a.state === 'past_due' ? -1 : 1
    if (a.state === 'past_due') return String(a.graceLastDay).localeCompare(String(b.graceLastDay))
    return String(b.downgradeOn).localeCompare(String(a.downgradeOn))
  })
}
