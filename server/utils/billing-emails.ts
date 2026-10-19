import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { sendEmail, isEmailConfigured, type SendEmailResult } from './email'
import { PAYMENT_ORDERS_COLLECTION } from './payment'
import { getQuotaAnswered } from './ai-usage'
import { effectivePlanOf } from './billing'
import {
  receiptEmail,
  chargeFailedEmail,
  downgradedEmail,
  renewalReminderEmail,
  rebindCardEmail,
  quotaEmail,
} from '~~/shared/billing/email-content'
import { RENEWAL_BIND_WINDOW_MS } from './workspace-alerts'
import { resolveRecurringCharge } from '~~/shared/billing/recurring'
import { getBillingPlan, isSelfServePaidPlan, type BillingPlanId, type WorkspaceSubscription } from '~~/shared/billing/plans'
import { rollSubscriptionToCurrentPeriod } from '~~/shared/billing/period'
import { graceDeadline, monthDayText } from '~~/shared/billing/dunning'
import { emailAttemptAllowed, emailAttemptsExhausted, nextEmailAttempt, type EmailAttempt } from '~~/shared/billing/email-retry'
import { taipeiDate } from '~~/shared/time'
import { resolveInvoiceProfile, type OrganizationDoc, type WorkspaceDoc } from '~~/shared/types/organization'
import type { PaymentOrderDoc } from '~~/shared/types/payment'

/**
 * 帳務通知信的協調層：解析收件人、組信、寄送、幂等守衛。
 *
 * 收件人 = 帳務信箱：發票 email（組織預設、OA 可覆寫）→ 組織登記擁有者 email。
 * 所有函式**永不 throw**——呼叫端都在金流 webhook / 排程對帳路徑上，寄信失敗不能拖累主流程。
 *
 * ⛔ `B-49`（2026-10-20）：「這期寄過了」的記號**只在寄成功（或根本沒有收件人）時才記**。
 *    以前寄完就無條件記，而 sendEmail 永不丟錯——SES 壞掉時每一封都被記成寄過、再也不重寄。
 *    寄失敗只記一筆「試過幾次」，下一輪排程照 shared/billing/email-retry.ts 的冷卻與上限再試。
 */

/**
 * 一封帳務信的結果。
 * - sent：寄出去了 → 記「寄過」
 * - no_recipient：沒有帳務信箱 → 也記「寄過」（寄不了，不必每 10 分鐘重算；同改版前的取捨）
 * - failed：寄信那層回錯（SES 拒寄、權限掉了…）→ 只記試過幾次，等下一輪
 * - not_configured：SES 沒設定 → 什麼都不記（設定好之後該寄的還是會寄）
 * - waiting：上次寄失敗、還在冷卻或已用完次數 → 這輪不試
 */
export type BillingEmailOutcome = 'sent' | 'no_recipient' | 'failed' | 'not_configured' | 'waiting'

function outcomeOf(r: SendEmailResult): BillingEmailOutcome {
  if (r.ok) return 'sent'
  return r.skipped ? 'not_configured' : 'failed'
}

interface UpdatableRef { update: (data: Record<string, unknown>) => Promise<unknown> }

/**
 * 依寄信結果寫回記號：成功／沒收件人 → `done`；失敗 → 只在 `attemptField` 記試過幾次。
 * 寫不進去只留 log（信的結果已經定了，記號沒寫到頂多下一輪多試一次）。
 */
async function settleEmailOutcome(p: {
  outcome: BillingEmailOutcome
  label: string
  id: string
  ref: UpdatableRef
  key: string
  prev: EmailAttempt | null | undefined
  nowMs: number
  done: Record<string, unknown>
  /** 沒有收件人時要寫的（預設同 done）；超管清單要分得出「寄了」跟「沒有信箱可寄」的，另外多記一格 */
  noRecipient?: Record<string, unknown>
  attemptField: string
}): Promise<void> {
  try {
    if (p.outcome === 'sent') {
      await p.ref.update(p.done)
      return
    }
    if (p.outcome === 'no_recipient') {
      await p.ref.update(p.noRecipient ?? p.done)
      return
    }
    if (p.outcome !== 'failed') return
    const attempt = nextEmailAttempt(p.prev, p.key, p.nowMs)
    await p.ref.update({ [p.attemptField]: attempt })
    if (emailAttemptsExhausted(attempt))
      console.error(`[billing-email] ${p.label}試了 ${attempt.attempts} 次都寄不出去，不再重試`, p.id, p.key)
    else
      console.warn(`[billing-email] ${p.label}寄不出去（第 ${attempt.attempts} 次），之後再試`, p.id, p.key)
  }
  catch (e) {
    console.error(`[billing-email] ${p.label}的寄送記號寫不進去`, p.id, (e as Error)?.message)
  }
}

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
 * 扣款失敗提醒（每期自動續扣失敗）。一期只寄一封：續扣排程在**第一次**失敗時呼叫；
 * 那次寄失敗的，由每日對帳（sendDueBillingEmails ①.6）照冷卻規則補寄。
 *
 * 信裡寫明「哪天前沒扣到就降回免費」（`B-16`）——日期跟帳單頁、實際降級同一把尺（graceDeadline）。
 * `periodStart` = 扣款失敗的那一期起日（past_due 的 currentPeriodStart），也是「這期寄過了」的記號值。
 */
export async function sendChargeFailedNotification(
  p: { workspaceId: string, planId: BillingPlanId, periodStart: string },
  db: Firestore = getDb(),
  now: Date = new Date(),
): Promise<BillingEmailOutcome> {
  try {
    const ref = db.collection('workspaces').doc(p.workspaceId)
    const snap = await ref.get()
    const sub = snap.exists ? (snap.data() as WorkspaceDoc).subscription : undefined
    if (sub?.chargeFailedEmailSentFor === p.periodStart) return 'sent' // 這期已寄過（重跑／補寄撞上）
    const prev = sub?.emailAttempts?.chargeFailed
    const nowMs = now.getTime()
    if (!emailAttemptAllowed(prev, p.periodStart, nowMs)) return 'waiting'

    const { email, workspaceName } = await resolveBillingRecipient(p.workspaceId, db)
    const { lastDay, downgradeOn } = graceDeadline(p.periodStart)
    const outcome: BillingEmailOutcome = email
      ? outcomeOf(await sendEmail({
          to: email,
          ...chargeFailedEmail({
            brandName: brandName(),
            workspaceName,
            planName: getBillingPlan(p.planId).name,
            manageUrl: billingUrl(p.workspaceId),
            lastDayText: monthDayText(lastDay),
            downgradeOnText: monthDayText(downgradeOn),
          }),
        }))
      : 'no_recipient'
    await settleEmailOutcome({
      outcome,
      label: '扣款失敗信',
      id: p.workspaceId,
      ref,
      key: p.periodStart,
      prev,
      nowMs,
      done: { 'subscription.chargeFailedEmailSentFor': p.periodStart },
      noRecipient: { 'subscription.chargeFailedEmailSentFor': p.periodStart, 'subscription.chargeFailedEmailNoRecipientFor': p.periodStart },
      attemptField: 'subscription.emailAttempts.chargeFailed',
    })
    return outcome
  }
  catch (e) {
    console.error('[billing-email] 扣款失敗信寄送失敗', p.workspaceId, (e as Error)?.message)
    return 'failed'
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

export interface DueBillingEmailsSummary {
  renewalReminders: number
  quotaNotices: number
  rebindNotices: number
  /** 補寄的扣款失敗信（第一次失敗那封沒寄出去的） */
  chargeFailedNotices: number
  /** 「已降回免費」信 */
  downgradeNotices: number
  /** 這一輪寄失敗的封數（各自會照冷卻規則再試） */
  failed: number
}

/**
 * 每日對帳的通知信階段：① 續扣前提醒 ①.5 綁卡提醒 ①.6 扣款失敗信補寄 ② 額度快用完/已用完 ③ 已降回免費。
 * **只有在 SES 設定齊全時才會執行**（未設定 → 直接回 0，連掃描都不做）——
 * 這讓「SES 還沒開通」的現狀完全零成本、零風險。
 *
 * 冪等：「已寄的期別」記在訂閱／訂單上（renewalReminderSentFor / quotaEmailSentFor / rebindEmailSentAt /
 * chargeFailedEmailSentFor / nonPaymentDowngrade.emailSent），**寄成功才記**（`B-49`），每輪重跑不會重寄。
 * 寄失敗的記在 emailAttempts，照冷卻（3 小時）與上限（5 次）重試，見 shared/billing/email-retry.ts。
 */
export async function sendDueBillingEmails(
  now: Date = new Date(),
  db: Firestore = getDb(),
): Promise<DueBillingEmailsSummary> {
  const summary: DueBillingEmailsSummary = { renewalReminders: 0, quotaNotices: 0, rebindNotices: 0, chargeFailedNotices: 0, downgradeNotices: 0, failed: 0 }
  if (!isEmailConfigured()) return summary

  const today = taipeiDate(now)
  const nowMs = now.getTime()
  const brand = brandName()
  const count = (outcome: BillingEmailOutcome, field: Exclude<keyof DueBillingEmailsSummary, 'failed'>) => {
    if (outcome === 'sent') summary[field]++
    else if (outcome === 'failed') summary.failed++
  }

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
      const key = sub.currentPeriodEnd
      const prev = sub.emailAttempts?.renewal
      if (!emailAttemptAllowed(prev, key, nowMs)) continue // 上次寄失敗、還在冷卻（或已放棄）
      const { email, workspaceName } = await resolveBillingRecipient(doc.id, db)
      const outcome: BillingEmailOutcome = email
        ? outcomeOf(await sendEmail({
            to: email,
            ...renewalReminderEmail({
              brandName: brand,
              workspaceName,
              planName: getBillingPlan(next.planId).name,
              amount: next.amount,
              chargeDate: addOneDay(sub.currentPeriodEnd),
              manageUrl: billingUrl(doc.id),
            }),
          }))
        : 'no_recipient'
      count(outcome, 'renewalReminders')
      // 寄成功（或沒有收件人，寄不了也不必天天重算）才記「這期寄過」；寄失敗只記試過幾次（`B-49`）
      await settleEmailOutcome({
        outcome,
        label: '續扣提醒',
        id: doc.id,
        ref: doc.ref,
        key,
        prev,
        nowMs,
        done: { 'subscription.renewalReminderSentFor': key },
        attemptField: 'subscription.emailAttempts.renewal',
      })
    }
  }
  catch (e) {
    console.error('[billing-email] 續扣提醒階段失敗', (e as Error)?.message)
  }

  // ── ①.5 首期付款成功、約定卡沒綁成：一次性提醒信（2026-08-28 拍板補的出口）──
  // 這個狀態原本沒有任何主動通知：付了錢的客戶下期不會被扣款、會被靜默降回免費層，
  // 唯一知道的方法是自己開後台。三個等值條件走自動索引合併；每筆訂單只寄一次
  // （冪等標記 rebindEmailSentAt 記在訂單上）。窗口與異常那顆同一把尺（45 天）。
  try {
    const unbound = await db.collection(PAYMENT_ORDERS_COLLECTION)
      .where('status', '==', 'paid')
      .where('kind', '==', 'period_first')
      .where('cardBound', '==', false)
      .limit(200)
      .get()
    const cutoff = now.getTime() - RENEWAL_BIND_WINDOW_MS
    for (const doc of unbound.docs) {
      const o = doc.data() as PaymentOrderDoc & { workspaceId?: string, createdAt?: { toMillis?: () => number } }
      if (o.rebindEmailSentAt) continue // 這筆已寄過
      const createdMs = typeof o.createdAt?.toMillis === 'function' ? o.createdAt.toMillis() : 0
      if (!createdMs || createdMs < cutoff) continue // 太舊的不追（多半已人工處理）
      const wid = String(o.workspaceId ?? '').trim()
      if (!wid) continue
      const key = doc.id
      const prev = o.rebindEmailAttempt
      if (!emailAttemptAllowed(prev, key, nowMs)) continue
      const { email, workspaceName } = await resolveBillingRecipient(wid, db)
      const outcome: BillingEmailOutcome = email
        ? outcomeOf(await sendEmail({
            to: email,
            ...rebindCardEmail({
              brandName: brand,
              workspaceName,
              planName: getBillingPlan(o.planId as BillingPlanId).name,
              manageUrl: billingUrl(wid),
            }),
          }))
        : 'no_recipient'
      count(outcome, 'rebindNotices')
      // 同續扣提醒：寄成功／沒收件人才記；寄失敗只記試過幾次（`B-49`）
      await settleEmailOutcome({
        outcome,
        label: '綁卡提醒',
        id: doc.id,
        ref: doc.ref,
        key,
        prev,
        nowMs,
        done: { rebindEmailSentAt: now },
        attemptField: 'rebindEmailAttempt',
      })
    }
  }
  catch (e) {
    console.error('[billing-email] 綁卡提醒階段失敗', (e as Error)?.message)
  }

  // ── ①.6 扣款失敗信補寄（`B-49`）──────────────────────────────────
  // 第一次扣款失敗時續扣排程會當場寄一封（payuni-recurring.ts）；那封寄失敗的話以前就永遠沒寄出去。
  // 這裡撿「這期扣失敗過、但信還沒寄成功」的，照冷卻規則補。寬限期已過的不寄（改寄「已降回免費」，③）。
  try {
    const pastDue = await db.collection('workspaces').where('subscription.status', '==', 'past_due').get()
    for (const doc of pastDue.docs) {
      const sub = (doc.data() as WorkspaceDoc).subscription
      const periodStart = sub?.currentPeriodStart
      if (!sub || !periodStart) continue
      if (sub.chargePeriodStart !== periodStart || !((sub.chargeAttempts ?? 0) >= 1)) continue // 這期還沒扣過
      if (!String(sub.lastChargeError ?? '').trim()) continue // 沒有失敗原因＝還在等結果（UNKNOWN），不是失敗
      if (sub.chargeFailedEmailSentFor === periodStart) continue
      if (rollSubscriptionToCurrentPeriod(sub, today).downgraded) continue
      const outcome = await sendChargeFailedNotification({
        workspaceId: doc.id,
        planId: resolveRecurringCharge(sub).planId,
        periodStart,
      }, db, now)
      count(outcome, 'chargeFailedNotices')
    }
  }
  catch (e) {
    console.error('[billing-email] 扣款失敗信補寄階段失敗', (e as Error)?.message)
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
      const prev = sub.emailAttempts?.quota
      if (!emailAttemptAllowed(prev, sentFor, nowMs)) continue

      const { email, workspaceName } = await resolveBillingRecipient(doc.id, db)
      const outcome: BillingEmailOutcome = email
        ? outcomeOf(await sendEmail({
            to: email,
            ...quotaEmail({
              brandName: brand,
              workspaceName,
              planName: getBillingPlan(sub.planId).name,
              used,
              quota,
              kind,
              manageUrl: billingUrl(doc.id),
            }),
          }))
        : 'no_recipient'
      count(outcome, 'quotaNotices')
      await settleEmailOutcome({
        outcome,
        label: '額度信',
        id: doc.id,
        ref: doc.ref,
        key: sentFor,
        prev,
        nowMs,
        done: { 'subscription.quotaEmailSentFor': sentFor },
        attemptField: 'subscription.emailAttempts.quota',
      })
    }
  }
  catch (e) {
    console.error('[billing-email] 額度通知階段失敗', (e as Error)?.message)
  }

  // ── ③ 已降回免費方案（`B-16`）──────────────────────────────────────
  // 降級落地時 runPaymentReconcile 會在訂閱上留 nonPaymentDowngrade（emailSent=false）；這裡照它寄一封。
  // 以前降級之後什麼都不寄，客人是發現 AI 沒在回才知道。
  try {
    const downs = await db.collection('workspaces')
      .where('subscription.nonPaymentDowngrade.emailSent', '==', false)
      .get()
    for (const doc of downs.docs) {
      const raw = (doc.data() as WorkspaceDoc).subscription
      const np = raw?.nonPaymentDowngrade
      if (!raw || !np?.on) continue
      // 降級之後又付了款（或晚到的扣款成功把方案救回來）→ 不寄「已降回免費」，直接收掉這筆
      if (isSelfServePaidPlan(rollSubscriptionToCurrentPeriod(raw, today).sub.planId)) {
        await doc.ref.update({ 'subscription.nonPaymentDowngrade.emailSent': true })
          .catch(e => console.warn('[billing-email] 已恢復付費的降級記號收不掉', doc.id, (e as Error)?.message))
        continue
      }
      const key = np.on
      const prev = raw.emailAttempts?.downgrade
      if (!emailAttemptAllowed(prev, key, nowMs)) continue
      const { email, workspaceName } = await resolveBillingRecipient(doc.id, db)
      const outcome: BillingEmailOutcome = email
        ? outcomeOf(await sendEmail({
            to: email,
            ...downgradedEmail({
              brandName: brand,
              workspaceName,
              planName: getBillingPlan(np.fromPlanId).name,
              onText: monthDayText(np.on),
              freeQuota: getBillingPlan('free').answeredQuota ?? 0,
              manageUrl: billingUrl(doc.id),
            }),
          }))
        : 'no_recipient'
      count(outcome, 'downgradeNotices')
      await settleEmailOutcome({
        outcome,
        label: '已降回免費信',
        id: doc.id,
        ref: doc.ref,
        key,
        prev,
        nowMs,
        done: { 'subscription.nonPaymentDowngrade.emailSent': true },
        noRecipient: { 'subscription.nonPaymentDowngrade.emailSent': true, 'subscription.nonPaymentDowngrade.noRecipient': true },
        attemptField: 'subscription.emailAttempts.downgrade',
      })
    }
  }
  catch (e) {
    console.error('[billing-email] 已降回免費信階段失敗', (e as Error)?.message)
  }

  return summary
}
