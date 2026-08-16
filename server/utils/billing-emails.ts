import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { sendEmail, isEmailConfigured } from './email'
import { PAYMENT_ORDERS_COLLECTION } from './payment'
import { getQuotaAnswered } from './ai-usage'
import { effectivePlanOf } from './billing'
import {
  receiptEmail,
  chargeFailedEmail,
  renewalReminderEmail,
  quotaEmail,
} from '~~/shared/billing/email-content'
import { resolveRecurringCharge } from '~~/shared/billing/recurring'
import { getBillingPlan, isSelfServePaidPlan, type BillingPlanId, type WorkspaceSubscription } from '~~/shared/billing/plans'
import { rollSubscriptionToCurrentPeriod } from '~~/shared/billing/period'
import { taipeiDate } from '~~/shared/time'
import { resolveInvoiceProfile, type OrganizationDoc, type WorkspaceDoc } from '~~/shared/types/organization'
import type { PaymentOrderDoc } from '~~/shared/types/payment'

/**
 * 帳務通知信的協調層：解析收件人、組信、寄送、幂等守衛。
 *
 * 收件人 = 帳務信箱：發票 email（組織預設、OA 可覆寫）→ 組織登記擁有者 email。
 * 所有函式**永不 throw**——呼叫端都在金流 webhook / 排程對帳路徑上，寄信失敗不能拖累主流程。
 */

function brandName(): string {
  const c = useRuntimeConfig()
  return String((c.public as Record<string, unknown>)?.brandName ?? '').trim() || 'MiniMe'
}

/**
 * 信用卡帳單上的請款名稱（與品牌名不同，見 shared/billing/statement.ts）。
 * 沒設就回空字串 → 收據信整列不出現，寧可不講也不要講錯的名字。
 */
function cardStatementName(): string {
  const c = useRuntimeConfig()
  return String((c.public as Record<string, unknown>)?.cardStatementName ?? '').trim()
}

function billingUrl(workspaceId: string): string {
  const c = useRuntimeConfig()
  const base = String(c.appBaseUrl ?? '').trim().replace(/\/$/, '')
  return `${base}/admin/${workspaceId}/settings/billing`
}

interface BillingRecipient {
  email: string | null
  workspaceName: string
}

/** 帳務通知收件人：resolveInvoiceProfile 的 buyerEmail → 組織 ownerEmail。 */
export async function resolveBillingRecipient(workspaceId: string, db: Firestore = getDb()): Promise<BillingRecipient> {
  const wsSnap = await db.collection('workspaces').doc(workspaceId).get()
  const ws = wsSnap.exists ? (wsSnap.data() as WorkspaceDoc) : null
  const workspaceName = ws?.name?.trim() || '你的官方帳號'

  let orgProfile: OrganizationDoc['invoiceProfile']
  let ownerEmail: string | null = null
  if (ws?.organizationId) {
    const orgSnap = await db.collection('organizations').doc(ws.organizationId).get()
    const org = orgSnap.exists ? (orgSnap.data() as OrganizationDoc) : null
    orgProfile = org?.invoiceProfile
    ownerEmail = String(org?.ownerEmail ?? '').trim() || null
  }

  const effective = resolveInvoiceProfile(orgProfile, ws?.invoiceProfile)
  const email = String(effective.buyerEmail ?? '').trim() || ownerEmail || null
  return { email, workspaceName }
}

/**
 * 付款成功收據。從訂單 doc 讀出方案/金額/本期/發票號碼（開通時已寫入）。
 * 呼叫端只在「首次結算成功」時呼叫（outcome=settled/renewed），故天然冪等。
 */
export async function sendReceiptNotification(orderId: string, db: Firestore = getDb()): Promise<void> {
  try {
    const snap = await db.collection(PAYMENT_ORDERS_COLLECTION).doc(orderId).get()
    if (!snap.exists) return
    const o = snap.data() as PaymentOrderDoc
    const { email, workspaceName } = await resolveBillingRecipient(o.workspaceId, db)
    if (!email) return
    const content = receiptEmail({
      brandName: brandName(),
      workspaceName,
      planName: getBillingPlan(o.planId).name,
      amount: o.amount,
      periodStart: o.periodStart ?? null,
      periodEnd: o.periodEnd ?? null,
      invoiceNumber: o.invoiceNumber ?? null,
      recurring: o.kind !== 'one_time',
      // 有折抵時收據要攤成「方案月費 − 折抵 = 實收」,否則客戶看到比定價少的數字會來問
      creditApplied: o.creditApplied ?? 0,
      // 帳單上的請款名稱（myfeel ≠ MiniMe）：收據信是離帳單最近的一份文件，
      // 客戶月底對帳翻信箱就對得起來 → 防爭議款（見 shared/billing/statement.ts）
      statementName: cardStatementName(),
    })
    await sendEmail({ to: email, ...content })
  }
  catch (e) {
    console.error('[billing-email] 收據寄送失敗', orderId, (e as Error)?.message)
  }
}

/**
 * 扣款失敗提醒（定期定額續期失敗）。呼叫端只在 outcome=past_due（首次失敗）時呼叫。
 */
export async function sendChargeFailedNotification(
  p: { workspaceId: string, planId: BillingPlanId },
  db: Firestore = getDb(),
): Promise<void> {
  try {
    const { email, workspaceName } = await resolveBillingRecipient(p.workspaceId, db)
    if (!email) return
    const content = chargeFailedEmail({
      brandName: brandName(),
      workspaceName,
      planName: getBillingPlan(p.planId).name,
      manageUrl: billingUrl(p.workspaceId),
    })
    await sendEmail({ to: email, ...content })
  }
  catch (e) {
    console.error('[billing-email] 扣款失敗信寄送失敗', p.workspaceId, (e as Error)?.message)
  }
}

/** YYYY-MM-DD 加一天（續扣日 = 本期末 + 1，與帳務頁的「下次扣款日」一致）。 */
function addOneDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** 續扣提醒往前幾天寄。 */
const RENEWAL_REMINDER_DAYS_AHEAD = 3
/** 額度信門檻（達 80% 寄 near）。 */
const QUOTA_NEAR_RATIO = 0.8
/** 每次對帳最多掃描的 workspace 數（防單日大掃描；超過只 log，不硬跑爆）。 */
const RECONCILE_SCAN_CAP = 2000

/**
 * 每日對帳的通知信階段：① 續扣前提醒 ② 額度快用完/已用完。
 * **只有在 SES 設定齊全時才會執行**（未設定 → 直接回 0，連掃描都不做）——
 * 這讓「SES 還沒開通」的現狀完全零成本、零風險。
 *
 * 冪等：兩者都把「已寄的期別」記在訂閱上（renewalReminderSentFor / quotaEmailSentFor），
 * 每日重跑不會重寄同一期同一封。
 */
export async function sendDueBillingEmails(
  now: Date = new Date(),
  db: Firestore = getDb(),
): Promise<{ renewalReminders: number, quotaNotices: number }> {
  if (!isEmailConfigured()) return { renewalReminders: 0, quotaNotices: 0 }

  const today = taipeiDate(now)
  const brand = brandName()
  let renewalReminders = 0
  let quotaNotices = 0

  // ── ① 續扣前提醒：本期末在 [today, today+N] 且自動續訂中 ──────────
  const windowEnd = (() => {
    const d = new Date(`${today}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + RENEWAL_REMINDER_DAYS_AHEAD)
    return d.toISOString().slice(0, 10)
  })()
  try {
    const soon = await db.collection('workspaces')
      .where('subscription.currentPeriodEnd', '>=', today)
      .where('subscription.currentPeriodEnd', '<=', windowEnd)
      .get()
    for (const doc of soon.docs) {
      const sub = (doc.data() as WorkspaceDoc).subscription
      if (!sub || !sub.autoRenew || sub.cancelAtPeriodEnd) continue
      if (!isSelfServePaidPlan(sub.planId)) continue
      if (!sub.currentPeriodEnd) continue
      if (sub.renewalReminderSentFor === sub.currentPeriodEnd) continue // 這期已寄過

      // 沒有約定卡 = 不會有任何排程來扣他 → 不能寄「我們即將向你收款」
      // （period.ts 也已不再給這種帳號寬限期,它到期就直接降級）。
      if (!sub.payuniCardToken) continue
      // ⚠️ 金額**必須**用 resolveRecurringCharge:它才會套用「期末降級」與「折抵」。
      //    自己拿 plan.priceMonthly 就會出現「信裡寫 799、帳單頁寫 399、實際扣 199」。
      //    這是 shared/billing/recurring.ts 存在的唯一理由,不要繞過它。
      const next = resolveRecurringCharge(sub)
      if (next.price == null) continue
      const { email, workspaceName } = await resolveBillingRecipient(doc.id, db)
      if (email) {
        const content = renewalReminderEmail({
          brandName: brand,
          workspaceName,
          planName: getBillingPlan(next.planId).name,
          amount: next.amount,
          chargeDate: addOneDay(sub.currentPeriodEnd),
          manageUrl: billingUrl(doc.id),
        })
        await sendEmail({ to: email, ...content })
        renewalReminders++
      }
      // 不論有無收件人都記旗標，避免每天重掃重試（沒 email 的帳號寄不了，不必天天重算）
      await doc.ref.update({ 'subscription.renewalReminderSentFor': sub.currentPeriodEnd })
    }
  }
  catch (e) {
    console.error('[billing-email] 續扣提醒階段失敗', (e as Error)?.message)
  }

  // ── ② 額度快用完 / 已用完：掃描有訂閱的帳號，比對用量 ────────────
  // 沒有「用量接近上限」的現成查詢（用量在另一個 doc），只能全掃。掃描已被 isEmailConfigured 擋在門外，
  // 開通 SES 前完全不跑；開通後於目前租戶量級可接受。超過上限只處理前 N 筆並 log。
  try {
    const all = await db.collection('workspaces').limit(RECONCILE_SCAN_CAP).get()
    if (all.size >= RECONCILE_SCAN_CAP) {
      console.warn('[billing-email] workspace 數達掃描上限，額度信可能未涵蓋全部', RECONCILE_SCAN_CAP)
    }
    for (const doc of all.docs) {
      const raw = (doc.data() as WorkspaceDoc).subscription
      if (!raw) continue
      const sub: WorkspaceSubscription = rollSubscriptionToCurrentPeriod(raw, today).sub
      if (!sub.currentPeriodStart) continue
      const { quota } = effectivePlanOf(sub)
      if (quota == null || quota <= 0) continue // 無上限（內部/企業/未設）→ 不通知

      const used = await getQuotaAnswered(doc.id, sub.currentPeriodStart, db)
      const kind: 'over' | 'near' | null
        = used >= quota ? 'over' : used >= quota * QUOTA_NEAR_RATIO ? 'near' : null
      if (!kind) continue

      const sentFor = `${sub.currentPeriodStart}:${kind}`
      if (sub.quotaEmailSentFor === sentFor) continue // 這期這門檻已寄過

      const { email, workspaceName } = await resolveBillingRecipient(doc.id, db)
      if (email) {
        const content = quotaEmail({
          brandName: brand,
          workspaceName,
          planName: getBillingPlan(sub.planId).name,
          used,
          quota,
          kind,
          manageUrl: billingUrl(doc.id),
        })
        await sendEmail({ to: email, ...content })
        quotaNotices++
      }
      await doc.ref.update({ 'subscription.quotaEmailSentFor': sentFor })
    }
  }
  catch (e) {
    console.error('[billing-email] 額度通知階段失敗', (e as Error)?.message)
  }

  return { renewalReminders, quotaNotices }
}
