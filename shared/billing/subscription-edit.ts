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

import { BILLING_PLAN_ORDER, DEFAULT_BILLING_PLAN_ID, effectiveAnsweredQuota, getBillingPlan, isSelfServePaidPlan } from './plans'
import type { BillingPlanId, SubscriptionStatus, WorkspaceSubscription } from './plans'
import { newSubscription, rollSubscriptionToCurrentPeriod } from './period'
import { isDueForRecurringCharge, resolveRecurringCharge } from './recurring'
import { graceDeadline } from './dunning'
import { addDays, dayOfDate, normalizeAnchorDay, taipeiDate } from '../time'

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

// ═══════════════════════════════════════════════════════════════════
//  超管改方案前的確認框內容（純函式；`B-43`④，2026-10-20）
//
//  改方案／狀態／到期日／額度以前按「儲存」就直接生效，沒有任何確認。`B-37` 修掉「整包覆蓋會毀綁卡」之後，
//  改方案本身仍是高風險操作：有綁卡的帳號，下次自動扣款會照新方案的月費扣；狀態改成「逾期未付」
//  會讓續扣排程在 10 分鐘內真的去刷卡；刪掉訂閱會連綁卡與折抵一起刪掉。
//  這裡把「改了什麼、會不會扣錢、客戶那邊會怎樣」算出來——用的是跟存檔、跟續扣排程**同一支**
//  applySuperSubscriptionEdit／isDueForRecurringCharge／resolveRecurringCharge，確認框講的就是實際會發生的事。
// ═══════════════════════════════════════════════════════════════════

/** 訂閱狀態的中文（超管編輯表單的選項也用這份） */
export const SUBSCRIPTION_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  active: '啟用中',
  trialing: '試用中',
  past_due: '逾期未付',
  canceled: '已取消',
}

export interface SuperEditPreview {
  /** 有沒有動到要確認的東西（方案／狀態／到期日／額度，或新增／刪掉訂閱）；只改名稱、組織、備註不用確認 */
  changed: boolean
  /** 改了什麼（一行一項） */
  changes: string[]
  /** 錢：存檔本身不扣錢；之後的自動扣款會怎樣 */
  money: string[]
  /** 會動到錢、或拿不回來的事（確認框用紅字） */
  warnings: string[]
  /** 客戶那邊看得到的影響 */
  customer: string[]
}

function quotaOf(sub: WorkspaceSubscription | null | undefined): number | null {
  if (!sub) return getBillingPlan(DEFAULT_BILLING_PLAN_ID).answeredQuota
  const canceled = sub.status === 'canceled'
  return effectiveAnsweredQuota(getBillingPlan(canceled ? DEFAULT_BILLING_PLAN_ID : sub.planId), canceled ? null : sub.quotaOverride)
}

function quotaText(q: number | null): string {
  return q == null ? '不設上限' : `${q.toLocaleString('en-US')} 則`
}

function moneyText(n: number): string {
  return `NT$${n.toLocaleString('en-US')}`
}

/** 這份訂閱之後會不會自動扣款：扣哪天、扣多少、哪個方案；不會自動扣回 null（先推到今天那一期，跟讀取端同一把尺） */
function nextAutoCharge(raw: WorkspaceSubscription | null | undefined, today: string): { date: string, amount: number, planName: string } | null {
  if (!raw) return null
  const sub = rollSubscriptionToCurrentPeriod(raw, today).sub
  if (sub.autoRenew !== true || sub.cancelAtPeriodEnd === true || !sub.payuniCardToken) return null
  if (sub.status === 'canceled' || !sub.currentPeriodEnd) return null
  if (!isSelfServePaidPlan(sub.planId)) return null
  const next = resolveRecurringCharge(sub)
  if (!isSelfServePaidPlan(next.planId) || next.price == null) return null
  // 扣款失敗中（今天已試過）→ 明天再試一次，不是等到期末；明天已過寬限期就不會再扣（會被降級）
  if (sub.status === 'past_due') {
    const tomorrow = addDays(today, 1)
    if (!sub.currentPeriodStart || tomorrow > graceDeadline(sub.currentPeriodStart).lastDay) return null
    return { date: tomorrow, amount: next.amount, planName: getBillingPlan(next.planId).name }
  }
  return { date: addDays(sub.currentPeriodEnd, 1), amount: next.amount, planName: getBillingPlan(next.planId).name }
}

/**
 * 算出超管存檔前要給他看的確認內容。
 * `payload` 跟送去 PATCH 的 subscription 一模一樣（null＝刪掉訂閱）；不合法的 planId／status 會照樣 throw（同存檔）。
 */
export function describeSuperSubscriptionEdit(
  before: WorkspaceSubscription | null | undefined,
  payload: unknown,
  today: string = taipeiDate(),
): SuperEditPreview {
  const preview: SuperEditPreview = { changed: false, changes: [], money: ['存檔本身不會扣錢，也不會開發票。'], warnings: [], customer: [] }
  const card = before?.payuniCardLast4 ? `•••• ${before.payuniCardLast4}` : '綁的卡'

  // ── 刪掉訂閱 ──
  if (payload == null) {
    if (!before) return preview
    preview.changed = true
    preview.changes.push(`刪掉訂閱資料（目前是${getBillingPlan(before.planId).name}方案）`)
    preview.customer.push(`會被當成免費方案：每期 AI 回覆 ${quotaText(quotaOf(before))} → ${quotaText(quotaOf(null))}，存檔後立刻生效。`)
    if (before.payuniCardToken)
      preview.warnings.push(`綁卡資料（${card}）會一起刪掉：之後不會再自動扣款，這張卡在金流那邊的約定也再也解不掉。`)
    if ((before.creditBalance ?? 0) > 0)
      preview.warnings.push(`客戶的折抵餘額 ${moneyText(Math.floor(before.creditBalance ?? 0))} 會一起消失。`)
    return preview
  }

  const after = applySuperSubscriptionEdit(before, payload)

  // ── 改了什麼 ──
  if (!before) {
    preview.changes.push(`新開一份訂閱：${getBillingPlan(after.planId).name}方案（${SUBSCRIPTION_STATUS_LABEL[after.status]}），本期 ${after.currentPeriodStart} ～ ${after.currentPeriodEnd}`)
  }
  else {
    if (before.planId !== after.planId)
      preview.changes.push(`方案：${getBillingPlan(before.planId).name} → ${getBillingPlan(after.planId).name}`)
    if (before.status !== after.status)
      preview.changes.push(`狀態：${SUBSCRIPTION_STATUS_LABEL[before.status] ?? before.status} → ${SUBSCRIPTION_STATUS_LABEL[after.status]}`)
    if ((before.currentPeriodEnd ?? null) !== (after.currentPeriodEnd ?? null))
      preview.changes.push(`到期日：${before.currentPeriodEnd ?? '沒設定'} → ${after.currentPeriodEnd ?? '沒設定'}`)
    if ((before.quotaOverride ?? null) !== (after.quotaOverride ?? null))
      preview.changes.push(`額度覆蓋：${before.quotaOverride != null ? quotaText(before.quotaOverride) : '用方案預設'} → ${after.quotaOverride != null ? quotaText(after.quotaOverride) : '用方案預設'}`)
  }
  preview.changed = preview.changes.length > 0
  if (!preview.changed) return preview

  // ── 客戶那邊 ──
  const qBefore = quotaOf(before)
  const qAfter = quotaOf(after)
  if (qBefore !== qAfter)
    preview.customer.push(`每期 AI 回覆額度：${quotaText(qBefore)} → ${quotaText(qAfter)}，存檔後立刻生效。`)
  if (after.status === 'canceled' && before?.status !== 'canceled')
    preview.customer.push('「已取消」＝客戶會被當成免費方案。')
  if (after.status === 'past_due' && before?.status !== 'past_due')
    preview.customer.push('帳單頁會出現「這期的自動扣款尚未成功」的黃色警示。')

  // 存檔後下一輪對帳（10 分鐘一輪）會不會直接把它降回免費：跟對帳用同一支 roll
  // （例：狀態改成「逾期未付」但這期起日早就過了寬限期、到期日改到今天以前）
  const willDowngrade = rollSubscriptionToCurrentPeriod(after, today).downgraded
  if (willDowngrade && !(before && rollSubscriptionToCurrentPeriod(before, today).downgraded)) {
    preview.warnings.push(`存檔後 10 分鐘內會被降回免費方案（每期 ${quotaText(quotaOf(null))}），之後也不會再自動扣款。`)
    return preview
  }

  // ── 錢 ──
  // 存檔後續扣排程（10 分鐘一輪）會不會真的去刷卡：跟排程用同一支判斷
  if (isDueForRecurringCharge(after, today)) {
    const charge = resolveRecurringCharge(after)
    preview.warnings.push(`存檔後 10 分鐘內，系統會向客戶的卡（${card}）扣 ${moneyText(charge.amount)}（${getBillingPlan(charge.planId).name}方案）。`)
    return preview
  }
  const nb = nextAutoCharge(before, today)
  const na = nextAutoCharge(after, today)
  if (na) {
    const line = `下次自動扣款：${na.date} 扣 ${moneyText(na.amount)}（${na.planName}方案）`
    if (nb && (nb.amount !== na.amount || nb.date !== na.date))
      preview.warnings.push(`${line}，原本是 ${nb.date} 扣 ${moneyText(nb.amount)}。`)
    else
      preview.money.push(`${line}。`)
  }
  else if (nb) {
    preview.warnings.push(`改完之後不會再自動扣款（原本 ${nb.date} 要扣 ${moneyText(nb.amount)}）；綁的卡保留。`)
  }
  return preview
}
