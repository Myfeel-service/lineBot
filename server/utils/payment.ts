/**
 * 付款（藍新金流）server 側工具：訂單帳本存取、由「已付款方案」組出訂閱物件、
 * 每日續期對帳。
 *
 * 純函式（組訂閱、訂單編號）可單元測試;會碰 Firestore 的部分（建單、開通、對帳）
 * 由 create-order API、Notify webhook 與排程呼叫。
 *
 * **付款週期對齊「錨定日」**（客戶付款那天）,不是日曆月：7/28 付款 → 7/28~8/27。
 * 額度桶 `quotaUsage/{ws}_{periodStart}` 跟著同一把尺,所以月底才升級的人不會付了
 * 整月的錢只買到幾天、額度還被同月份的免費用量吃掉。成本報表仍走日曆月
 * （aiUsage）,兩把尺刻意分開,見 shared/time.ts。
 */
import { FieldValue } from 'firebase-admin/firestore'
import type { Firestore, Timestamp } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { invalidateWorkspaceSubscriptionCache } from './billing'
import { addDays, dayOfDate, taipeiDate } from '~~/shared/time'
import { isSelfServePaidPlan, type BillingPlanId, type WorkspaceSubscription } from '~~/shared/billing/plans'
import { anchorDayOf, confirmRenewal, newSubscription, rollSubscriptionToCurrentPeriod } from '~~/shared/billing/period'
import { terminatePeriodMandate, type PeriodMandateConfig } from './newebpay-period'
import type { WorkspaceDoc } from '~~/shared/types/organization'
import type { PaymentOrderDoc, PaymentOrderKind, PaymentOrderStatus } from '~~/shared/types/payment'

export const PAYMENT_ORDERS_COLLECTION = 'paymentOrders'

const pad = (n: number, len = 2) => String(n).padStart(len, '0')

/**
 * 由「已付款方案」組出 workspace 訂閱物件（active、方案預設額度）。
 * 付款開通與 super admin 手動開通產出的訂閱形狀一致。
 *
 * 兩種情形：
 *
 * · **續訂同一個方案且尚未到期** → 期間堆疊：新一期接在現有到期日的隔天,錨定日不變。
 *   避免「還沒到期就提前續訂 → 週期被重設 → 白付一次」。
 *
 * · **從免費升級 / 換方案** → 立刻生效：錨定日重設為付款日,本期從今天起算一整期。
 *   這正是修掉「7/28 付 799 卻只買到 3 天」的地方。
 *
 * ⚠️ 換方案時舊方案的**剩餘天數不折抵**（按比例補差額 proration 留到接定期定額時一起做）。
 *    目前結帳 UI 只做升級,升級的人拿到完整一期,不會吃虧;真要做降級前得先補上折抵。
 */
export function buildPaidSubscription(
  planId: BillingPlanId,
  now: Date,
  existingSub?: WorkspaceSubscription | null,
  opts?: {
    /** 藍新定期定額委託單號；有值即代表這是自動續訂的訂閱。 */
    periodNo?: string | null
    /** 建立該委託的商店訂單編號（取消時 AlterStatus 要成對帶）。 */
    periodOrderNo?: string | null
    /**
     * 建單當下決定的錨定日（= 送給藍新的 PeriodPoint）。定期定額**必須**帶,
     * 且必須是建單時存下來的那個值,不能在這裡用 now 重算——見 PaymentOrderDoc.anchorDay。
     */
    anchorDay?: number | null
  },
): WorkspaceSubscription {
  const today = taipeiDate(now)
  const isPeriod = Boolean(opts?.periodNo)

  // 定期定額**不堆疊**：藍新那張委託的扣款日是 PeriodPoint（= 建單當天），我方的續期日
  // 必須跟它同一天。若沿用舊訂閱的錨定日（堆疊），兩邊就會錯開，每個月都會出現
  // 「我方到期進寬限期 → 藍新還沒到扣款日 → 寬限期滿 → 把有在付錢的客戶降級」。
  // 換方案時舊委託已在 create-subscription 被終止，本來就該重新起算。
  const stacking = !isPeriod
    && existingSub != null
    && existingSub.planId === planId
    && isSelfServePaidPlan(planId)
    && existingSub.status !== 'canceled'
    && existingSub.currentPeriodEnd != null
    && existingSub.currentPeriodEnd >= today

  const anchorDay = stacking
    ? anchorDayOf(existingSub!)
    : (opts?.anchorDay ?? dayOfDate(today))
  const startDate = stacking ? addDays(existingSub!.currentPeriodEnd!, 1) : today

  const sub = newSubscription(planId, startDate, { anchorDay })
  // 同方案續訂保留 super admin 設定的特批額度;換方案則以新方案預設為準。
  if (existingSub?.planId === planId && existingSub.quotaOverride != null) {
    sub.quotaOverride = existingSub.quotaOverride
  }
  // 定期定額：記下委託單號並開啟自動續訂（到期不會直接降級,改走寬限期等扣款通知）
  if (opts?.periodNo) {
    sub.periodNo = opts.periodNo
    sub.autoRenew = true
    sub.cancelAtPeriodEnd = false
    if (opts.periodOrderNo) sub.periodOrderNo = opts.periodOrderNo
  }
  return sub
}

/** 3 碼英數亂數尾碼（訂單編號用）。 */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 5).toUpperCase().padEnd(3, '0')
}

/**
 * 產生商店訂單編號：`NP` + UTC yyMMddHHmmss + 3 碼亂數 = **17 碼**。
 *
 * 長度是被**電子發票**綁死的,不是藍新：
 *   · 藍新 MerOrderNo 上限 30 碼（英數與底線）——很寬鬆。
 *   · 定期定額每期的 OrderNo = `本單號_期數`,最多再加 3 碼（`_99`）→ 20 碼。
 *   · ezPay 發票的 MerchantOrderNo 上限就是 **20 碼**。
 * 所以本單號一超過 17 碼,第 2 期之後的續期發票就會全部被 ezPay 退件。
 */
export function newMerchantOrderNo(now: Date, rand: string = randomSuffix()): string {
  const ts = `${String(now.getUTCFullYear()).slice(2)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `NP${ts}${rand}`.slice(0, 17)
}

/** ezPay 發票的自訂編號上限（Varchar(20)）。 */
export const INVOICE_ORDER_NO_MAX = 20

// ── Firestore 存取 ─────────────────────────────────────────────────

/** 寫入一筆 pending 訂單（建單 API 用）。 */
export async function createPendingOrder(
  order: {
    merchantOrderNo: string
    workspaceId: string
    organizationId?: string | null
    planId: BillingPlanId
    amount: number
    createdBy?: string | null
    kind?: PaymentOrderKind
    /** 定期定額：建單當下決定的錨定日（= PeriodPoint），開通時沿用不重算。 */
    anchorDay?: number | null
    /** 換方案：這張新委託開通成功後要終止的舊委託（見 PaymentOrderDoc.supersedes*）。 */
    supersedesPeriodNo?: string | null
    supersedesPeriodOrderNo?: string | null
    /**
     * 客戶結帳前勾選同意的條款版本（POLICY_VERSION）。
     * 由端點驗證前端確實帶了同意才傳進來；時間戳在這裡蓋（不信前端的時間）。
     */
    termsVersion?: string | null
  },
  db: Firestore = getDb(),
): Promise<void> {
  const doc: PaymentOrderDoc = {
    merchantOrderNo: order.merchantOrderNo,
    workspaceId: order.workspaceId,
    organizationId: order.organizationId ?? null,
    planId: order.planId,
    amount: order.amount,
    status: 'pending',
    kind: order.kind ?? 'one_time',
    anchorDay: order.anchorDay ?? null,
    supersedesPeriodNo: order.supersedesPeriodNo ?? null,
    supersedesPeriodOrderNo: order.supersedesPeriodOrderNo ?? null,
    periodNo: null,
    tradeNo: null,
    paymentType: null,
    failReason: null,
    periodStart: null,
    periodEnd: null,
    createdBy: order.createdBy ?? null,
    termsVersion: order.termsVersion ?? null,
    termsAcceptedAt: order.termsVersion ? FieldValue.serverTimestamp() : null,
    createdAt: FieldValue.serverTimestamp(),
    paidAt: null,
    updatedAt: FieldValue.serverTimestamp(),
    notifyRaw: null,
  }
  // create()：訂單編號碰撞時失敗（不覆蓋既有訂單）
  await db.collection(PAYMENT_ORDERS_COLLECTION).doc(order.merchantOrderNo).create(doc)
}

/** 讀一筆訂單（定期定額續期時要用原始委託單找回 workspace 與方案）。 */
export async function getOrder(
  merchantOrderNo: string,
  db: Firestore = getDb(),
): Promise<PaymentOrderDoc | null> {
  const snap = await db.collection(PAYMENT_ORDERS_COLLECTION).doc(merchantOrderNo).get()
  return snap.exists ? (snap.data() as PaymentOrderDoc) : null
}

/**
 * 作廢此帳號「其它還在 pending 的訂單」（留下 keepOrderNo 那筆）。
 * 建新單 / 沿用單前呼叫 → 帳單頁**永遠只有一筆進行中的待付款**,一次解決「繼續付款堆一排」
 * 與「換方案 A→B 留兩筆」（keepOrderNo 傳沿用的舊單號,沒有沿用就傳 null 全清）。
 * 誤殺客戶隨後才付款的舊單也沒關係:settlePaidOrder 對「expired + 已付款」仍會復活開通
 * （見該函式,收了錢就得給服務）。查詢沿用 (workspaceId, createdAt) 既有索引;失敗安全跳過。
 */
export async function supersedePendingOrders(
  workspaceId: string,
  keepOrderNo: string | null,
  db: Firestore = getDb(),
): Promise<number> {
  try {
    const snap = await db.collection(PAYMENT_ORDERS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(30)
      .get()
    const batch = db.batch()
    let n = 0
    for (const d of snap.docs) {
      const o = d.data() as PaymentOrderDoc
      if (o.status !== 'pending' || o.merchantOrderNo === keepOrderNo) continue
      batch.update(d.ref, { status: 'expired' as PaymentOrderStatus, updatedAt: FieldValue.serverTimestamp() })
      n++
    }
    if (n > 0) await batch.commit()
    return n
  }
  catch (e) {
    console.warn('[payment] supersedePendingOrders failed (skip):', e)
    return 0
  }
}

/** 列出 pending 訂單（主動查單對帳用）。limit 上限避免 backlog 一次撈爆 + 對閘道打太多查詢。 */
export async function getPendingOrders(db: Firestore = getDb(), limit = 200): Promise<PaymentOrderDoc[]> {
  const snap = await db.collection(PAYMENT_ORDERS_COLLECTION).where('status', '==', 'pending').limit(limit).get()
  return snap.docs.map(d => d.data() as PaymentOrderDoc)
}

/**
 * 作廢一筆「自己帳號」的 pending 訂單（使用者在帳單頁按「取消」）。
 * transaction 內先確認歸屬與現況:不是自己的擋掉、已非 pending 也擋掉（避免作廢已付款的單）。
 */
export async function voidPendingOrder(
  merchantOrderNo: string,
  workspaceId: string,
  db: Firestore = getDb(),
): Promise<'voided' | 'not_pending' | 'not_found' | 'forbidden'> {
  const ref = db.collection(PAYMENT_ORDERS_COLLECTION).doc(merchantOrderNo)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return 'not_found'
    const o = snap.data() as PaymentOrderDoc
    if (o.workspaceId !== workspaceId) return 'forbidden'
    if (o.status !== 'pending') return 'not_pending'
    tx.update(ref, { status: 'expired' as PaymentOrderStatus, updatedAt: FieldValue.serverTimestamp() })
    return 'voided'
  })
}

/** 建單去重視窗:同帳號同方案在此時間內的 pending 訂單會被沿用,避免連點重複扣款。 */
const PENDING_REUSE_MS = 30 * 60 * 1000

/**
 * 找同帳號、同方案、近 30 分鐘內尚未付款的 pending 訂單以便沿用（沿用同一
 * MerchantOrderNo → 藍新端也會擋掉重複付款）。查詢失敗（如索引未建）回 null,
 * 退化成建新單,不阻斷結帳。
 */
export async function findRecentPendingOrder(
  workspaceId: string,
  planId: BillingPlanId,
  now: Date,
  db: Firestore = getDb(),
): Promise<PaymentOrderDoc | null> {
  try {
    const snap = await db.collection(PAYMENT_ORDERS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get()
    const cutoff = now.getTime() - PENDING_REUSE_MS
    for (const d of snap.docs) {
      const o = d.data() as PaymentOrderDoc
      if (o.status !== 'pending' || o.planId !== planId) continue
      const ms = (o.createdAt as Timestamp)?.toMillis?.() ?? 0
      if (ms >= cutoff) return o
    }
    return null
  }
  catch (e) {
    console.warn('[payment] findRecentPendingOrder failed (skip dedup):', e)
    return null
  }
}

export interface SettleOrderResult {
  /** 'settled' = 本次成功入帳並開通;'already' = 已是終態(冪等跳過);'unknown' = 查無此訂單 */
  outcome: 'settled' | 'already' | 'unknown'
  workspaceId?: string
  planId?: BillingPlanId
  /** 實際入帳金額（開發票用） */
  amount?: number
  /** 付款金額與建單金額不符（疑似竄改）；此時標記失敗、不開通 */
  amountMismatch?: boolean
  /**
   * 換方案：本次開通的新委託所取代的**舊**委託單號。開通成功後由 period-notify 拿去
   * 終止舊委託（此刻才終止，放棄付款的客戶舊訂閱才不會被白白殺掉）。
   */
  supersedesPeriodNo?: string | null
  supersedesPeriodOrderNo?: string | null
}

/**
 * 依 Notify 結果結算訂單並（成功時）開通訂閱。
 *
 * 用 Firestore transaction 把「訂單狀態」與「workspace 訂閱」原子寫入,並以訂單
 * 現況做冪等：已是 paid/failed/expired 則跳過（藍新會重送 Notify 直到收 200）。
 * 開通成功後清 billing 快取,讓則數額度攔截立即改用新方案。
 */
export async function settlePaidOrder(
  input: {
    merchantOrderNo: string
    paid: boolean
    tradeNo?: string | null
    paymentType?: string | null
    /** 付款失敗時的原因（PAYUNi Message）；標記 failed 時一併寫入供帳單頁顯示 */
    failReason?: string | null
    /** Notify 回傳的付款金額；與訂單金額不符則標記失敗、不開通（防竄改） */
    amount?: number
    /** 定期定額委託單號（首期 Notify 回傳）；有值 → 訂閱開啟自動續訂 */
    periodNo?: string | null
    now: Date
    notifyRaw?: Record<string, unknown> | null
  },
  db: Firestore = getDb(),
): Promise<SettleOrderResult> {
  const orderRef = db.collection(PAYMENT_ORDERS_COLLECTION).doc(input.merchantOrderNo)

  const result = await db.runTransaction<SettleOrderResult>(async (tx) => {
    const snap = await tx.get(orderRef)
    if (!snap.exists) return { outcome: 'unknown' }
    const order = snap.data() as PaymentOrderDoc
    // 冪等 / 終態保護：
    // - paid  → 一律跳過（redelivery）。仍回報 supersedes（僅先前真的開通的 paid 單）,
    //           讓「首次開通成功、終止舊委託卻失敗」能在重送時補做終止（終止冪等）。
    // - failed → 跳過（視為終態決標,不因後續回拋反覆改）。
    if (order.status === 'paid' || order.status === 'failed') {
      return {
        outcome: 'already',
        workspaceId: order.workspaceId,
        planId: order.planId,
        ...(order.status === 'paid'
          ? { supersedesPeriodNo: order.supersedesPeriodNo ?? null, supersedesPeriodOrderNo: order.supersedesPeriodOrderNo ?? null }
          : {}),
      }
    }
    // 逾期單：**這次確認已付款才復活開通**——收了錢就得給服務（例:建單時自動作廢舊
    // 待付款後,客戶隔一會兒才在舊付款頁完成付款）。非付款成功的 expired 一律跳過。
    if (order.status === 'expired' && !input.paid) {
      return { outcome: 'already', workspaceId: order.workspaceId, planId: order.planId }
    }
    // 到此：status === 'pending',或（expired && paid）→ 往下結算開通

    // 讀現有訂閱（續訂堆疊 + 保留 quotaOverride 用）;Firestore 要求所有讀在所有寫之前
    const wsRef = db.collection('workspaces').doc(order.workspaceId)
    let existingSub: WorkspaceSubscription | undefined
    if (input.paid) {
      const wsSnap = await tx.get(wsRef)
      existingSub = wsSnap.exists ? (wsSnap.data() as WorkspaceDoc).subscription : undefined
    }

    const base = {
      tradeNo: input.tradeNo ?? null,
      paymentType: input.paymentType ?? null,
      notifyRaw: input.notifyRaw ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    }

    if (!input.paid) {
      tx.update(orderRef, { ...base, status: 'failed' as PaymentOrderStatus, failReason: input.failReason ?? '付款未成功' })
      return { outcome: 'settled', workspaceId: order.workspaceId, planId: order.planId }
    }

    if (input.amount != null && input.amount !== order.amount) {
      // 付款金額與建單金額不符（疑似竄改）→ 不開通,標記失敗
      tx.update(orderRef, { ...base, status: 'failed' as PaymentOrderStatus, failReason: `金額不符（應付 NT$${order.amount}）` })
      return { outcome: 'settled', workspaceId: order.workspaceId, planId: order.planId, amountMismatch: true }
    }

    const sub = buildPaidSubscription(order.planId, input.now, existingSub, {
      periodNo: input.periodNo,
      periodOrderNo: input.periodNo ? order.merchantOrderNo : null,
      // 沿用建單時的錨定日（= 送給藍新的 PeriodPoint），不要在這裡重算
      anchorDay: order.anchorDay,
    })
    tx.update(orderRef, {
      ...base,
      status: 'paid' as PaymentOrderStatus,
      paidAt: FieldValue.serverTimestamp(),
      periodNo: input.periodNo ?? null,
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
    })
    // 同一 transaction 內原子寫入訂閱 → 訂單 paid 與方案開通不會半套
    tx.update(wsRef, {
      subscription: sub,
      updatedAt: FieldValue.serverTimestamp(),
    })
    return {
      outcome: 'settled',
      workspaceId: order.workspaceId,
      planId: order.planId,
      amount: order.amount,
      // 換方案：新委託開通了 → 回報要終止的舊委託（同一張新委託時兩者不會相同）
      supersedesPeriodNo: order.supersedesPeriodNo ?? null,
      supersedesPeriodOrderNo: order.supersedesPeriodOrderNo ?? null,
    }
  })

  // 開通後清快取（transaction 外，確保已 commit）
  if (result.outcome === 'settled' && result.workspaceId) {
    invalidateWorkspaceSubscriptionCache(result.workspaceId)
  }
  return result
}

// ── 定期定額：第 2 期以後的自動扣款 ────────────────────────────────

export interface SettleRecurringResult {
  outcome: 'renewed' | 'past_due' | 'already' | 'unknown'
  workspaceId?: string
  planId?: BillingPlanId
  amount?: number
  /** 本期的帳本單號（= 藍新的 OrderNo，`原單號_期數`）；開發票用 */
  ledgerOrderNo?: string
}

/**
 * 結算定期定額的「每期授權」通知（NPA-N050）。
 *
 * 與首期不同：**我方沒有預先建單**——藍新自動扣款後才回拋。所以這裡是
 * 「拿原始委託單找回 workspace 與方案 → 補寫一筆本期帳 → 續期訂閱」。
 *
 * 冪等：本期帳的 doc id 用藍新的 `OrderNo`（`原單號_期數`，每期唯一），
 * 用 create() 搶寫;已存在即代表這期處理過 → 直接跳過（藍新會重送直到收 200）。
 *
 * 扣款失敗（Status ≠ SUCCESS）→ 訂閱維持 past_due,不動方案。寬限期用完後
 * rollSubscriptionToCurrentPeriod 會自然把它降回免費層（見 shared/billing/period.ts）。
 */
export async function settleRecurringAuth(
  input: {
    /** 原始委託的商店訂單編號（MerchantOrderNo） */
    merchantOrderNo: string
    /** 本期單號（OrderNo = `原單號_期數`）；藍新未回傳時退回自行組出 */
    ledgerOrderNo: string
    paid: boolean
    periodNo?: string | null
    tradeNo?: string | null
    amount?: number
    periodTimes?: number | null
    now: Date
    notifyRaw?: Record<string, unknown> | null
  },
  db: Firestore = getDb(),
): Promise<SettleRecurringResult> {
  const today = taipeiDate(input.now)
  const originRef = db.collection(PAYMENT_ORDERS_COLLECTION).doc(input.merchantOrderNo)
  const ledgerRef = db.collection(PAYMENT_ORDERS_COLLECTION).doc(input.ledgerOrderNo)

  // ⚠️ 帳本與訂閱**必須在同一個 transaction 裡**。
  // 之前是先 create() 帳本、再 update() 訂閱：只要中間掛掉（Lambda 逾時、Firestore 抖動）,
  // 藍新重送時就會撞到「帳本已存在 → 冪等跳過」,訂閱永遠續不了期——客戶錢扣了、方案卻在
  // 寬限期滿之後被降級,而且連發票都不會開。冪等鍵一旦先落地，就再也沒有第二次機會了。
  const result = await db.runTransaction<SettleRecurringResult>(async (tx) => {
    const originSnap = await tx.get(originRef)
    if (!originSnap.exists) return { outcome: 'unknown' }
    const origin = originSnap.data() as PaymentOrderDoc

    // 原始委託單已被判定失敗（金額不符 / 逾期清理）→ 這張委託本來就不該生效。
    // 不能因為藍新照樣扣了款就把方案開起來,那等於「失敗的訂單被續期通知復活」。
    if (origin.status === 'failed') {
      console.error('[payment] 續期通知對應到一張已失敗的委託單,拒絕開通', input.merchantOrderNo)
      return { outcome: 'unknown', workspaceId: origin.workspaceId, planId: origin.planId }
    }

    const ledgerSnap = await tx.get(ledgerRef)
    if (ledgerSnap.exists) {
      // 這一期處理過了（藍新重送）→ 冪等跳過
      return { outcome: 'already', workspaceId: origin.workspaceId, planId: origin.planId }
    }

    const wsRef = db.collection('workspaces').doc(origin.workspaceId)
    const wsSnap = await tx.get(wsRef)
    const existing = wsSnap.exists ? (wsSnap.data() as WorkspaceDoc).subscription : undefined

    const ledger: PaymentOrderDoc = {
      merchantOrderNo: input.ledgerOrderNo,
      workspaceId: origin.workspaceId,
      organizationId: origin.organizationId ?? null,
      planId: origin.planId,
      amount: input.amount ?? origin.amount,
      status: (input.paid ? 'paid' : 'failed') as PaymentOrderStatus,
      kind: 'period_recurring' as PaymentOrderKind,
      anchorDay: origin.anchorDay ?? null,
      periodNo: input.periodNo ?? origin.periodNo ?? null,
      periodTimes: input.periodTimes ?? null,
      tradeNo: input.tradeNo ?? null,
      paymentType: 'CREDIT',
      periodStart: null,
      periodEnd: null,
      createdBy: null,
      createdAt: FieldValue.serverTimestamp(),
      paidAt: input.paid ? FieldValue.serverTimestamp() : null,
      updatedAt: FieldValue.serverTimestamp(),
      notifyRaw: input.notifyRaw ?? null,
    }

    if (!input.paid) {
      tx.create(ledgerRef, ledger)
      // 扣款失敗 → past_due（服務照跑,等寬限期與後續重試）。降級一律交給 roll 統一處理,
      // 免得「失敗通知」與「寬限期推算」對降級時機各說各話。
      // 只有還在付費方案上才標 past_due——已經被降回免費層的帳號再標 past_due 會卡死
      // （免費層不在寬限期邏輯的管轄內，狀態永遠清不掉）。
      if (existing && isSelfServePaidPlan(existing.planId)) {
        tx.update(wsRef, {
          subscription: { ...existing, status: 'past_due' },
          updatedAt: FieldValue.serverTimestamp(),
        })
      }
      return { outcome: 'past_due', workspaceId: origin.workspaceId, planId: origin.planId }
    }

    // 扣款成功 → 續期：推到當期、方案由「原始訂單」決定（見 confirmRenewal 的警告）
    const base = existing ?? buildPaidSubscription(origin.planId, input.now, null, {
      periodNo: input.periodNo,
      periodOrderNo: origin.merchantOrderNo,
      anchorDay: origin.anchorDay,
    })
    const renewed = confirmRenewal(base, today, {
      planId: origin.planId,
      periodNo: input.periodNo ?? origin.periodNo,
      periodOrderNo: origin.merchantOrderNo,
    })

    tx.create(ledgerRef, {
      ...ledger,
      periodStart: renewed.currentPeriodStart,
      periodEnd: renewed.currentPeriodEnd,
    })
    tx.update(wsRef, { subscription: renewed, updatedAt: FieldValue.serverTimestamp() })

    return {
      outcome: 'renewed',
      workspaceId: origin.workspaceId,
      planId: origin.planId,
      amount: input.amount ?? origin.amount,
      ledgerOrderNo: input.ledgerOrderNo,
    }
  })

  if (result.workspaceId && (result.outcome === 'renewed' || result.outcome === 'past_due')) {
    invalidateWorkspaceSubscriptionCache(result.workspaceId)
  }
  return result
}

// ── 每日續期對帳（reconcile）────────────────────────────────────────

/**
 * pending 訂單「無人聞問」多久算逾期（reconcile 純清理）。信用卡即時付款,3 小時綽綽有餘。
 * ⚠️ 未來若開 ATM／超商代碼（繳費碼可用數天），要改成按 kind 給更長 TTL,否則會把「還能繳」的
 *    單提早標逾期。就算標了,客戶事後真的繳費,settlePaidOrder 對「expired + 已付款」仍會復活開通。
 */
const STALE_PENDING_MS = 3 * 60 * 60 * 1000

/**
 * 每日對帳：① 過期的訂閱 → 滾到當期（免費層補回額度；付費方案沒續費則降回免費）
 *          ② 卡住的 pending 訂單 → expired（純清理,不影響訂閱）。
 *
 * ⚠️ 這支排程是**把結果落地成資料**,不是正確性的前提。真正決定「現在是哪一期、
 *    額度該不該歸零」的是 `rollSubscriptionToCurrentPeriod`,它在每次讀訂閱時就地推算。
 *    所以排程沒跑（Amplify 不跑 scheduledTasks,這個雷踩過）,額度重置與到期降級照樣
 *    正確,只是 Firestore 裡的 subscription 欄位會暫時停留在舊的一期。
 *
 * 由外部排程（EventBridge 帶 X-Cron-Secret 打 /api/payment/reconcile）每日觸發。
 */
export async function runPaymentReconcile(
  now: Date = new Date(),
  db: Firestore = getDb(),
  /** 降級時用來終止藍新委託；未提供則只寫資料庫（單元測試用）。 */
  periodCfg?: PeriodMandateConfig | null,
): Promise<{ renewed: number; downgraded: number; terminated: number; expiredOrders: number }> {
  const today = taipeiDate(now)

  let renewed = 0
  let downgraded = 0
  let terminated = 0
  const stale = await db.collection('workspaces').where('subscription.currentPeriodEnd', '<', today).get()
  for (const doc of stale.docs) {
    const sub = (doc.data() as WorkspaceDoc).subscription
    if (!sub) continue
    const rolled = rollSubscriptionToCurrentPeriod(sub, today)
    if (!rolled.changed) continue

    // 降級（沒續費 / 寬限期滿）→ 藍新那張委託還活著,還會扣客戶的卡。
    // 我方都不給付費方案了,就必須主動把它停掉——否則客戶會「服務被降級、錢照扣」。
    if (rolled.downgraded && rolled.sub.periodNo && rolled.sub.periodOrderNo && periodCfg) {
      const t = await terminatePeriodMandate(rolled.sub.periodOrderNo, rolled.sub.periodNo, periodCfg)
      if (t.ok) {
        delete rolled.sub.periodNo
        delete rolled.sub.periodOrderNo
        terminated++
      }
      else {
        // 停不掉 → 單號留著（下次對帳與客戶的取消按鈕都還能再試一次）
        console.error('[payment] 降級時終止委託失敗,卡片可能仍在扣款', doc.id, t.code, t.message)
      }
    }

    await doc.ref.update({ subscription: rolled.sub, updatedAt: FieldValue.serverTimestamp() })
    invalidateWorkspaceSubscriptionCache(doc.id)
    renewed++
    if (rolled.downgraded) downgraded++
  }

  let expiredOrders = 0
  const staleCutoffMs = now.getTime() - STALE_PENDING_MS
  const pending = await db.collection(PAYMENT_ORDERS_COLLECTION).where('status', '==', 'pending').get()
  for (const doc of pending.docs) {
    const createdAt = (doc.data() as PaymentOrderDoc).createdAt as Timestamp
    const ms = createdAt && typeof createdAt.toMillis === 'function' ? createdAt.toMillis() : 0
    if (ms && ms < staleCutoffMs) {
      await doc.ref.update({ status: 'expired' as PaymentOrderStatus, updatedAt: FieldValue.serverTimestamp() })
      expiredOrders++
    }
  }

  return { renewed, downgraded, terminated, expiredOrders }
}
