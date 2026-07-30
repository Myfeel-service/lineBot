// ═══════════════════════════════════════════════════════════════════
//  方案顯示視圖 + 額度使用狀態（純函式，前後端共用）
//
//  「方案卡」在多處出現（用量監控、設定頁、帳號選單…）。門檻（近上限 80%、
//  超量 100%）與顏色寫在這裡當單一事實來源，各處只呼叫 derivePlanState，
//  不各自重算，避免規則飄移。
// ═══════════════════════════════════════════════════════════════════

import type { BillingPlanId, SubscriptionStatus } from './plans'

/** 對前端顯示用的方案視圖（由訂閱組出，見 server/utils/billing.ts buildPlanView）。 */
export interface PlanView {
  id: BillingPlanId
  name: string
  /** 本期生效則數額度（含 quotaOverride）；null = 客製無固定上限。 */
  answeredQuota: number | null
  /** 超量加購單價（TWD/則）；null = 不提供超量。 */
  overagePerReply: number | null
  /** 本期起訖（YYYY-MM-DD）。週期由錨定日決定,不是日曆月（見 shared/time.ts）。 */
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  /** 訂閱狀態。past_due = 自動扣款還沒成功，正在寬限期（服務照跑）。 */
  status: SubscriptionStatus
  /** 是否每月自動續訂（背後有生效中的定期定額委託）。 */
  autoRenew: boolean
  /** 已取消，但服務用到本期結束。 */
  cancelAtPeriodEnd: boolean
  /**
   * 金流那邊還有一張生效中的扣款委託（PAYUNi 的信用卡約定 Token,或舊藍新的定期定額委託）。
   *
   * 這和 autoRenew **不是同一件事**：扣款失敗被降回免費層之後 autoRenew 是 false，
   * 但委託還活著、卡還綁著。取消／換卡入口要看這個旗標，不能看 autoRenew，
   * 否則客戶會落到「服務被降級、卡還綁著、按鈕還不見了」。
   * （只回布林值，Token／委託單號不外洩到前端。）
   */
  hasMandate: boolean
  /** 扣款卡末四碼（有約定卡時才有）；UI 顯示「扣款卡 •••• 1234」。非憑證。 */
  cardLast4?: string | null
  /**
   * 最後一次自動續扣失敗的原因（金流回的訊息，如「卡片授權失敗」「額度不足」）。
   * past_due 時要把它顯示出來——只講「扣款未成功」等於叫客戶自己猜是哪裡出問題。
   */
  lastChargeError?: string | null
  /** 已預約於期末生效的方案（降級）；null = 下期沿用現行方案。 */
  pendingPlanId?: BillingPlanId | null
  /** 上者的顯示名稱（前端不用自己去查方案表）。 */
  pendingPlanName?: string | null
  /** 可折抵下期扣款的餘額（含稅元）。 */
  creditBalance?: number
  /**
   * 下期實際會扣的金額（= 下期方案月費 − 折抵）。
   * 與排程算的是**同一支純函式**（shared/billing/recurring.ts）——畫面說扣多少就真的扣多少。
   */
  nextChargeAmount?: number | null
}

export type QuotaState = 'ok' | 'near' | 'over'

export interface PlanUsageState {
  used: number
  limit: number | null
  remaining: number | null
  /** 夾在 0–100 供進度條用。 */
  percent: number
  /** 真實百分比，可 >100（超量時顯示實際值）。 */
  percentRaw: number
  state: QuotaState
  /** 進度條顏色（綠/橙/紅）。 */
  color: string
}

/** 近上限門檻（百分比）。 */
export const QUOTA_NEAR_THRESHOLD = 80

const QUOTA_COLORS: Record<QuotaState, string> = {
  over: '#f56c6c',
  near: '#e6a23c',
  ok: '#0f7b54',
}

/** 由「方案 + 本期已用則數」導出額度使用狀態。plan 為 null（未訂閱）時回 ok/無上限。 */
export function derivePlanState(
  plan: Pick<PlanView, 'answeredQuota'> | null | undefined,
  answered: number,
): PlanUsageState {
  const used = answered || 0
  const limit = plan?.answeredQuota ?? null
  const percentRaw = limit ? Math.round((used / limit) * 100) : 0
  const percent = Math.min(100, percentRaw)
  const remaining = limit == null ? null : Math.max(0, limit - used)

  let state: QuotaState = 'ok'
  if (limit != null) {
    if (used >= limit) state = 'over'
    else if (percentRaw >= QUOTA_NEAR_THRESHOLD) state = 'near'
  }

  return { used, limit, remaining, percent, percentRaw, state, color: QUOTA_COLORS[state] }
}
