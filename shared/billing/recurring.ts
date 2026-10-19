// ═══════════════════════════════════════════════════════════════════
//  續扣金額與方案的決策（純函式，前後端共用）
//
//  PAYUNi 的 Token 模型讓「每期扣多少、扣哪個方案」都由我方決定（見
//  docs/PAYUNI-RECURRING-DESIGN.md §4）。所以「降級期末生效」與「退費折抵下一期」
//  不需要動金流委託，只是**下一期扣款時算出來的數字不一樣**。
//
//  規則寫在這裡當單一事實來源：排程照它扣款、帳單頁照它顯示「下期會扣多少」。
//  兩邊各自重算就會出現「畫面說扣 399、實際扣 799」——那是客訴，不是顯示瑕疵。
// ═══════════════════════════════════════════════════════════════════

import { BILLING_PLAN_ORDER, getBillingPlan, isSelfServePaidPlan, type BillingPlanId, type WorkspaceSubscription } from './plans'
import { GRACE_DAYS } from './period'
import { addDays } from '../time'

/**
 * 下一期生效的方案 = 已排程的變更（pendingPlanId）優先，否則沿用現行方案。
 *
 * 「降級期末生效」就是靠這個：按下降級時**不動** planId（客戶本期照舊用到底、剩餘天數不蒸發），
 * 只寫 pendingPlanId；期末續扣時才以它為準扣款並開通。
 * pendingPlanId 指向不存在／同一個方案時視為沒有排程（防呆：不讓壞資料把方案卡住）。
 */
export function resolveNextPeriodPlanId(sub: WorkspaceSubscription): BillingPlanId {
  const pending = sub.pendingPlanId
  if (!pending || pending === sub.planId) return sub.planId
  if (!BILLING_PLAN_ORDER.includes(pending)) return sub.planId
  return pending
}

/** 方案在 BILLING_PLAN_ORDER 裡的位置；用來判斷是升級還是降級。 */
export function planRank(id: BillingPlanId): number {
  return BILLING_PLAN_ORDER.indexOf(id)
}

/**
 * 目標方案相對現行方案是不是「降級」。
 * enterprise / test / internal 不參與自助升降級（走合約或 super admin 指派）。
 */
export function isDowngrade(from: BillingPlanId, to: BillingPlanId): boolean {
  return planRank(to) < planRank(from)
}

export interface RecurringChargePlan {
  /** 下一期要開通的方案 */
  planId: BillingPlanId
  /** 方案月費（含稅整數）；null = 客製／不可自助續扣 */
  price: number | null
  /** 本期實際要向信用卡請款的金額（已扣折抵） */
  amount: number
  /** 本期用掉的折抵金額 */
  creditUsed: number
  /** 用掉之後剩下的折抵餘額 */
  creditRemaining: number
  /**
   * 折抵把這期蓋滿了（amount = 0）→ **不會有信用卡交易**。
   * 呼叫端要走「不扣款直接續期」那條路：金流不接受 0 元請款，硬送會被退。
   */
  fullyCovered: boolean
}

/**
 * 算出「下一期要扣多少錢、開哪個方案」。
 *
 * 折抵規則（老闆 2026-07-29 拍板）：可累積、逐期折到用完，每期先折 min(餘額, 月費)。
 * 折抵是「下期少收錢」→ 下期發票就開少收後的實收金額，原發票完全不動、不用折讓（稅務乾淨）。
 */
export function resolveRecurringCharge(sub: WorkspaceSubscription): RecurringChargePlan {
  const planId = resolveNextPeriodPlanId(sub)
  const price = getBillingPlan(planId).priceMonthly
  const balance = Math.max(0, Math.floor(sub.creditBalance ?? 0))

  if (price == null || price <= 0) {
    return { planId, price, amount: 0, creditUsed: 0, creditRemaining: balance, fullyCovered: false }
  }
  const creditUsed = Math.min(balance, price)
  const amount = price - creditUsed
  return {
    planId,
    price,
    amount,
    creditUsed,
    creditRemaining: balance - creditUsed,
    fullyCovered: amount <= 0,
  }
}

/**
 * 這筆訂閱現在該不該被自動續扣。
 *
 * 純函式,好測也好講：**只有 roll 已經把它推進新一期、標成 past_due 的自動續訂才算 due**。
 * active 的不扣（本期已付）、按過取消的不扣、沒 Token 的不扣（扣不了）、
 * 免費／企業／內部方案不扣（沒有月費或走合約）。
 *
 * 2026-10-20（`B-43`④）從 server/utils/payuni-recurring.ts **原封不動搬來**（那邊照樣匯出同一支）：
 * 超管改方案的確認框要用同一個條件講「存檔後會不會被扣款」——條件寫兩份就會漂，
 * 漂掉的那天確認框說不會扣、排程照扣。⛔ 改這裡＝改續扣排程本身，要跑 payuni-recurring 的測試。
 */
export function isDueForRecurringCharge(sub: WorkspaceSubscription | null | undefined, today: string): boolean {
  if (!sub) return false
  if (sub.status !== 'past_due') return false
  if (sub.autoRenew !== true || sub.cancelAtPeriodEnd === true) return false
  if (!sub.payuniCardToken) return false
  // 沒有本期起日 = 壞資料（手動塞的 doc / 寫入中斷）:算不出單號也判不了寬限期,不能碰。
  if (!sub.currentPeriodStart) return false
  // **寬限期已過** → 這筆該被降級,不是再扣一次。
  // 少了這道檢查,只要「降級沒被寫回 Firestore」就會變成每天重扣同一張被拒的卡
  // （降級的落地由 runPaymentReconcile 的 past_due 那一段負責,這裡是第二道保險）。
  if (addDays(sub.currentPeriodStart, GRACE_DAYS) < today) return false
  if (!isSelfServePaidPlan(sub.planId)) return false
  // 用「下一期實際會開通的方案」判斷（降級排程可能把它換掉）——若排的是不可自助續扣的
  // 方案（客製／內部）就不該由程式刷卡,交給人處理。
  const { planId: nextPlanId, price } = resolveRecurringCharge(sub)
  if (!isSelfServePaidPlan(nextPlanId)) return false
  if (price == null || price <= 0) return false
  // 今天已經試過（成功會變 active,所以走到這裡代表今天已失敗或還在等 UNKNOWN 結果）
  if (sub.lastChargeDate === today) return false
  return true
}
