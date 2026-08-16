// ═══════════════════════════════════════════════════════════════════
//  超管「編輯帳號」的訂閱寫入（純函式）
//
//  ⚠️ 為什麼要有這支：2026-08-16 稽核抓到超管存檔會**整包取代** subscription map——
//  前端每次存檔都無條件重建訂閱送出，後端拿表單值蓋掉整個物件，於是超管只是改個
//  名稱或備註，客戶的綁卡（payuniCardToken）、折抵餘額（creditBalance）、預約降級
//  （pendingPlanId）全部被靜默清掉：下期不會扣款、欠客戶的錢憑空蒸發，且無告警。
//
//  修法＝**表單只管表單的欄位**：方案／狀態／週期／錨定日／額度覆蓋／備註。
//  其餘欄位（計費憑證與續扣狀態）一律原樣保留——用「從舊值出發、只覆寫表單欄位」
//  的方向合併，未來新增的欄位也自動安全，不用維護保留清單。
// ═══════════════════════════════════════════════════════════════════

import { BILLING_PLAN_ORDER } from './plans'
import type { BillingPlanId, SubscriptionStatus, WorkspaceSubscription } from './plans'
import { newSubscription } from './period'
import { dayOfDate, normalizeAnchorDay, taipeiDate } from '../time'

const VALID_STATUS: SubscriptionStatus[] = ['active', 'trialing', 'past_due', 'canceled']

/** 表單驗證失敗（planId／status 不合法）。API 層轉成 400。 */
export class SubscriptionEditError extends Error {}

/**
 * 套用超管編輯表單到（可能已存在的）訂閱上。
 *
 * - 沒有既有訂閱 → 建一份新的（週期用錨定日制：未帶起始日 → 今天；
 *   未帶到期日 → 由錨定日自動算出）。
 * - 已有訂閱 → 只覆寫表單管的欄位；`quotaOverride`／`note` 清空＝移除。
 *   `pendingPlanId` 刻意保留：那是客戶自己預約的期末變更，超管改方案不該偷偷吃掉它
 *   （若真要取消預約，客戶端帳單頁本來就有「取消預約」）。
 */
export function applySuperSubscriptionEdit(
  existing: WorkspaceSubscription | null | undefined,
  raw: unknown,
): WorkspaceSubscription {
  const r = (raw ?? {}) as Record<string, unknown>
  const planId = r.planId as BillingPlanId
  if (!BILLING_PLAN_ORDER.includes(planId)) {
    throw new SubscriptionEditError('invalid planId')
  }
  const status = (r.status ?? 'active') as SubscriptionStatus
  if (!VALID_STATUS.includes(status)) {
    throw new SubscriptionEditError('invalid subscription status')
  }

  const start = r.currentPeriodStart ? String(r.currentPeriodStart).slice(0, 10) : taipeiDate()
  const anchorDay = r.anchorDay ? normalizeAnchorDay(Number(r.anchorDay)) : dayOfDate(start)

  const edited = newSubscription(planId, start, { anchorDay, status })
  // 明確指定到期日（合約特例）時尊重之；否則用錨定日自動算出的那一期
  if (r.currentPeriodEnd) edited.currentPeriodEnd = String(r.currentPeriodEnd).slice(0, 10)

  const override = Number(r.quotaOverride)
  const hasOverride
    = r.quotaOverride != null && r.quotaOverride !== '' && Number.isFinite(override) && override >= 0
  const note = String(r.note ?? '').trim()

  // 從舊值出發，只覆寫表單欄位——綁卡／折抵／續扣狀態原樣跟著走
  const merged: WorkspaceSubscription = {
    ...(existing ?? {}),
    planId: edited.planId,
    status: edited.status,
    currentPeriodStart: edited.currentPeriodStart,
    currentPeriodEnd: edited.currentPeriodEnd,
    anchorDay: edited.anchorDay,
  }
  if (hasOverride) merged.quotaOverride = Math.floor(override)
  else delete merged.quotaOverride
  if (note) merged.note = note
  else delete merged.note
  return merged
}
