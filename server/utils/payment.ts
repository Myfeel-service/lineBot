/**
 * 付款（PAYUNi 統一金流）server 側工具：訂單帳本存取、由「已付款方案」組出訂閱物件、
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
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { invalidateWorkspaceSubscriptionCache } from './billing'
import { addDays, dayOfDate, taipeiDate } from '~~/shared/time'
import { isSelfServePaidPlan, type BillingPlanId, type WorkspaceSubscription } from '~~/shared/billing/plans'
import { anchorDayOf, confirmRenewal, newSubscription, rollSubscriptionToCurrentPeriod } from '~~/shared/billing/period'
import { cancelCardBinding, type PayuniCardMandate, type PayuniKeys } from './payuni'
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
 * ⚠️ **立即換方案**時舊方案的剩餘天數不折抵（按比例補差額 proration 仍未做）。升級的人拿到
 *    完整一期不吃虧;**降級已改走「期末生效」**（pendingPlanId,見 shared/billing/recurring.ts）,
 *    所以現在不會有人因為降級而虧掉已付天數。
 */
export function buildPaidSubscription(
  planId: BillingPlanId,
  now: Date,
  existingSub?: WorkspaceSubscription | null,
  opts?: {
    /**
     * 建單當下決定的錨定日。自動續訂**必須**帶,且必須是建單時存下來的那個值,
     * 不能在這裡用 now 重算——見 PaymentOrderDoc.anchorDay。
     */
    anchorDay?: number | null
    /**
     * PAYUNi 首刷建立的信用卡約定（`CreditHash` + 末四碼 + 有效期）。
     * 有值 → 開啟自動續訂,之後每期由**我方排程**拿 Token 幕後扣款。
     */
    payuniCard?: PayuniCardMandate | null
  },
): WorkspaceSubscription {
  const today = taipeiDate(now)

  // 期間堆疊：同方案、還沒到期 → 新一期接在現有到期日之後,錨定日不變。
  //
  // ⚠️ PAYUNi 的 Token 模型**允許**堆疊（藍新定期定額不行,因為金流端有自己固定的扣款日
  //    會與我方續期日錯開;那套程式已於 2026-07-30 移除）。PAYUNi 的扣款日由我方排程依
  //    currentPeriodEnd 決定,所以客戶提前改成自動續訂,照樣把新一期接在到期日後面
  //    ——不吃掉他已付的剩餘天數。
  const stacking = existingSub != null
    && existingSub.planId === planId
    && isSelfServePaidPlan(planId)
    && existingSub.status !== 'canceled'
    // past_due = 「已滾進新一期但**這一期還沒收到錢**」（等自動續扣／寬限期中）。
    // 這時堆疊是錯的:它假設「你已經付到期末了」,於是把新買的一期接在到期日後面 →
    // 客戶付了錢卻拿到一段未來的期間,而沒付款的本期照樣在寬限期到底後被降級。
    // 沒付錢的那一期不該被當成資產,所以從今天重新起算一整期。
    && existingSub.status !== 'past_due'
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
  // 折抵餘額**一定要帶過來**。newSubscription 是全新物件,不帶就等於客戶付一次錢、
  // 我們順手把欠他的折抵刪掉——那是拿走客戶的錢,不是「重新起算一期」的一部分。
  // （對比 pendingPlanId：那是「期末要換成哪個方案」的指示,客戶現在主動換了方案就已經
  //   取代掉那個指示,刻意**不**帶過來,否則會在期末把他剛買的方案又降回去。）
  if (existingSub?.creditBalance != null && existingSub.creditBalance > 0) {
    sub.creditBalance = existingSub.creditBalance
  }
  // PAYUNi：存下約定卡 Token,之後每期由我方排程幕後扣款。
  // ⚠️ 只有拿到 Token 才開 autoRenew——「付款成功但沒建成約定」必須留在單次付款語意,
  //    否則到期會等一筆永遠不會發生的續扣,把客戶卡在寬限期直到降級。
  const card = opts?.payuniCard?.token
    ? opts.payuniCard
    // 這一筆沒有建新約定（例：已訂閱的人手動補刷一期）→ **沿用**原有的約定卡。
    // 不能讓它掉：CreditHash 是我方唯一能對 PAYUNi 解除約定（credit_bind/cancel 的 BindVal）的憑證,
    // 弄丟就變成「客戶那張卡在 PAYUNi 還綁著,我方卻再也取消不了」。
    : (existingSub?.payuniCardToken
        ? { token: existingSub.payuniCardToken, last4: existingSub.payuniCardLast4 ?? null, expiry: existingSub.payuniCardExpiry ?? null }
        : null)
  if (card) {
    sub.payuniCardToken = card.token
    if (card.last4) sub.payuniCardLast4 = card.last4
    if (card.expiry) sub.payuniCardExpiry = card.expiry
    // 新建的約定一律開自動續訂；沿用舊 Token 時尊重客戶原本的意願（他可能已按過取消）。
    sub.autoRenew = opts?.payuniCard?.token ? true : existingSub?.autoRenew === true
    sub.cancelAtPeriodEnd = opts?.payuniCard?.token ? false : existingSub?.cancelAtPeriodEnd === true
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
 * 17 碼這個長度來自 **ezPay 時期**的「自訂編號 ≤20 碼」限制（定期定額每期會加 `_期數` 後綴）。
 *
 * ✅ **已改用光貿（Amego）並實測過**（2026-07-30，公開測試帳號 12345678）：17／19／20／21／
 *    24／30 碼的 OrderId **全部開立成功** → 光貿至少收到 30 碼，20 碼不是它的限制。
 *    目前的瓶頸只剩 PAYUNi `MerTradeNo` 的 25 碼。17 碼予以保留（沒有理由改動已在跑的格式），
 *    續扣單號另有自己的產生器（payuni-recurring.ts `recurringOrderNo`，19 碼）。
 */
export function newMerchantOrderNo(now: Date, rand: string = randomSuffix()): string {
  const ts = `${String(now.getUTCFullYear()).slice(2)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `NP${ts}${rand}`.slice(0, 17)
}

/**
 * 訂單編號的安全長度上限。
 * 光貿實測至少吃 30 碼（見上方註解），所以現在真正的瓶頸是 **PAYUNi `MerTradeNo` ≤25 碼**。
 * 保守取 20 當守門值：離兩邊上限都有餘裕，測試也用它把關。
 */
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
    /** 自動續訂：建單當下決定的錨定日，開通時沿用不重算。 */
    anchorDay?: number | null
    /** 續扣：這筆用掉的折抵金額（amount 已扣掉它）；結算成功時從訂閱餘額扣除。 */
    creditApplied?: number | null
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
    creditApplied: order.creditApplied ?? null,
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

/** 讀一筆訂單。 */
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
 *
 * ⚠️ **`period_recurring` 一律不動**。那是續扣排程自己開的單,只有它知道有沒有拿到結果;
 *    被這裡作廢掉的話,`getPendingOrders`（只選 pending）就再也查不到它 →
 *    「PAYUNi 回 UNKNOWN、之後銀行核准了」那筆錢會收進來卻永遠開不通,而且沒有任何紀錄。
 *    客戶在帳單頁按「升級／續訂／換卡」剛好撞上排程正在扣款,就會發生。
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
      if (o.kind === 'period_recurring') continue // 排程擁有的單,不能被前台建單順手作廢（見上方註解）
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

/**
 * 記下一次「PAYUNi 說查無此單」的觀測,回傳這筆單**第一次**被這樣觀測到的時間（毫秒;
 * 不適用回 0）。只給 reconcilePayuniPending 的續扣單作廢判斷用。
 *
 * 為什麼要跨兩輪才算數:作廢是不可逆的,而「查無」這個結論完全建立在一個**沒有簽章**的
 * 外層狀態碼上（查無的回應本來就沒有 EncryptInfo 可驗,同 queryCardBinding／cancelCardBinding）。
 * 單一次觀測分不出「PAYUNi 根本沒收到」與「查詢庫還沒同步／我方查錯環境」——後者誤判時
 * 被作廢的是**可能已經授權成功**的那一期,下一輪就會再刷一次客戶的卡（續扣單號帶當次
 * 嘗試日期,PAYUNi 端不會擋）。要求相隔數分鐘的兩輪對帳都查無,代價只是晚幾分鐘重試。
 *
 * 觀測時間刻意不清除:pending 單最多活 3 天(STALE_RECURRING_PENDING_MS),在這段期間內
 * 「曾經查無 + 現在又查無」已足以佐證,為了清乾淨而在每次查詢成功時多寫一次不划算。
 */
export async function markRecurringNotFoundSeen(
  merchantOrderNo: string,
  workspaceId: string,
  now: Date,
  db: Firestore = getDb(),
): Promise<number> {
  const ref = db.collection(PAYMENT_ORDERS_COLLECTION).doc(merchantOrderNo)
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) return 0
      const o = snap.data() as PaymentOrderDoc
      // 不是這個 workspace 的、或已經不是 pending（剛被 Notify 開通了）→ 不必也不該再判斷
      if (o.workspaceId !== workspaceId || o.status !== 'pending') return 0
      const seen = (o.notFoundSeenAt as Timestamp | undefined)?.toMillis?.() ?? 0
      if (seen > 0) return seen
      tx.update(ref, { notFoundSeenAt: Timestamp.fromDate(now), updatedAt: FieldValue.serverTimestamp() })
      return now.getTime()
    })
  }
  catch (e) {
    console.warn('[payment] markRecurringNotFoundSeen failed (skip):', e)
    return 0
  }
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
  /**
   * 只沿用**同 kind** 的舊單。單次付款與「建立信用卡約定」送給 PAYUNi 的參數不同,
   * 而開通時是照訂單的 kind 決定要不要存 Token——沿用到 kind 不同的舊單,就會出現
   * 「客戶以為訂閱了、實際只買了一期」。留 undefined = 不比對（維持舊行為）。
   */
  kind?: PaymentOrderKind,
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
      if (kind && (o.kind ?? 'one_time') !== kind) continue
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
   * 這次開通用新 Token 取代掉的**舊** Token（換卡／重新訂閱時才有）。
   *
   * 呼叫端必須拿它去 `credit_bind/cancel` 解約:舊 `CreditHash` 是唯一能解除那組約定的憑證,
   * 被新 Token 覆蓋掉之後就再也解不了 → 客戶每換一次卡,就在他的卡上多留一組
   * 永遠無法解除的約定。
   */
  replacedCardToken?: string | null
  /**
   * 這是一筆「要建立信用卡約定」的訂單（period_first）,錢收到了卻**沒拿到 Token**。
   *
   * 客戶付了首月、服務照開,但**不會有下一期自動扣款**——他會在期末默默掉回免費層。
   * 呼叫端要大聲記錄（並在 P3 接通知）,這是需要人去看的狀況,不是可以吞掉的雜訊。
   */
  cardBindFailed?: boolean
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
    /**
     * PAYUNi 首刷回傳的信用卡約定（`CreditHash` 等）。
     *
     * ⚠️ **只有 `kind === 'period_first'` 的訂單才會被採用**（在 transaction 內以訂單的 kind
     *    為閘門）。理由：若 PAYUNi 在一筆單次付款也回了 CreditHash,照收就會把「只想買一期」
     *    的客戶悄悄變成每月自動扣款——那是會上新聞的那種錯,寧可漏存也不能誤存。
     */
    payuniCard?: PayuniCardMandate | null
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
    // - paid  → 一律跳過（redelivery）。
    // - failed → 跳過（視為終態決標,不因後續回拋反覆改）。
    if (order.status === 'paid' || order.status === 'failed') {
      return { outcome: 'already', workspaceId: order.workspaceId, planId: order.planId }
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

    // 建約定只認「當初就是為了建約定而開的單」（見 input.payuniCard 註解）。
    const bindsCard = order.kind === 'period_first'
    const payuniCard = bindsCard ? (input.payuniCard ?? null) : null
    // ⚠️ 只對 `one_time` 警告。`period_recurring` 的 /api/credit 回應**本來就會**帶回
    //    CreditHash（官方文件列為「續用」欄位）,每筆續扣都印一行會把日誌淹掉,
    //    真正該警覺的情況（單次付款卻回來一組約定）就再也看不見了。
    if (input.payuniCard?.token && !bindsCard && (order.kind ?? 'one_time') === 'one_time') {
      console.warn('[payment] 單次付款訂單卻收到 CreditHash,不建立約定:', input.merchantOrderNo)
    }

    // 續扣（第 2 期以後）**不能**用 buildPaidSubscription。
    // 到期時 roll 已經把訂閱推進新一期並標 past_due（額度照給、服務照跑）,此時要做的是
    // 「把**已經滾進來的這一期**確認為已付款」= confirmRenewal。若走 buildPaidSubscription,
    // 它會判定「同方案未到期 → 期間堆疊」把本期再往後推一期 → 客戶一次扣款拿到兩個月。
    const today = taipeiDate(input.now)
    let sub: WorkspaceSubscription
    if (order.kind === 'period_recurring') {
      const base = existingSub
        ?? newSubscription(order.planId, today, { anchorDay: order.anchorDay ?? undefined })
      // 方案由**訂單**決定（建單時已把 pendingPlanId 解析成 order.planId）→ 降級在此生效
      sub = confirmRenewal(base, today, { planId: order.planId })
      // 上一次失敗的原因已經不成立了,別留在畫面上（帳單頁會顯示它）
      delete sub.lastChargeError
      // 排程的方案變更已經生效 → 清掉,否則下一期會再套一次同一個變更
      delete sub.pendingPlanId
      // 折抵：扣掉這筆真的用掉的額度。以**訂單上的值**為準（不是重算）——重試／查單補救
      // 走同一條路時才不會重複扣或漏扣餘額。
      const used = Math.max(0, Math.floor(order.creditApplied ?? 0))
      if (used > 0) {
        const left = Math.max(0, Math.floor(existingSub?.creditBalance ?? 0) - used)
        if (left > 0) sub.creditBalance = left
        else delete sub.creditBalance
      }
    }
    else {
      sub = buildPaidSubscription(order.planId, input.now, existingSub, {
        // 沿用建單時的錨定日，不要在這裡重算（跨午夜建單會差一天）
        anchorDay: order.anchorDay,
        payuniCard,
      })
    }
    tx.update(orderRef, {
      ...base,
      status: 'paid' as PaymentOrderStatus,
      paidAt: FieldValue.serverTimestamp(),
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
      // 稽核：這一筆有沒有真的建成約定（末四碼非憑證,Token 本身只存在訂閱上）
      cardBound: Boolean(payuniCard?.token),
      cardLast4: payuniCard?.last4 ?? null,
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
      // 收了訂閱首期的錢卻沒拿到 Token → 之後不會自動扣款,要人看（見欄位註解）
      cardBindFailed: bindsCard && !sub.payuniCardToken,
      // 換卡:舊 Token 被新的取代 → 回報給呼叫端去解約（見欄位註解）
      replacedCardToken: existingSub?.payuniCardToken && sub.payuniCardToken !== existingSub.payuniCardToken
        ? existingSub.payuniCardToken
        : null,
    }
  })

  // 開通後清快取（transaction 外，確保已 commit）
  if (result.outcome === 'settled' && result.workspaceId) {
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
 * 續扣單（`period_recurring`）的逾期門檻——**刻意比一般 pending 長得多**。
 *
 * 那是排程自己開的單,而 `/api/credit` 有「UNKNOWN 之後才有結果」的非同步路徑:
 * 只要在 3 小時內被標成 expired,`getPendingOrders`（只選 pending）就再也查不到它,
 * 銀行事後核准的那筆錢就會收進來卻永遠開不通。給 3 天讓 `trade/query` 有充分機會補查。
 */
const STALE_RECURRING_PENDING_MS = 3 * 24 * 60 * 60 * 1000

/**
 * 每日對帳：① 過期的訂閱 → 滾到當期（免費層補回額度；付費方案沒續費則降回免費）
 *          ② **past_due 的訂閱 → 寬限期滿的降級要落地**（見下方註解,少了這段會每天重扣）
 *          ③ 卡住的 pending 訂單 → expired（純清理,不影響訂閱）。
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
  /**
   * PAYUNi 特店設定;有給才會在降級時順手向 PAYUNi 解除卡片約定（清潔工作）。
   * 不給 → 只寫資料庫、Token 留著（單元測試與金流未設定時走這條）。
   */
  payuni?: { merchantId: string; keys: PayuniKeys; env: unknown; relayBase?: unknown } | null,
): Promise<{ renewed: number; downgraded: number; unbound: number; expiredOrders: number }> {
  const today = taipeiDate(now)

  let renewed = 0
  let downgraded = 0
  let unbound = 0
  const seen = new Set<string>()

  /** 把一個 workspace 的訂閱推進到當期並落地;有降級就順手解除卡片約定。 */
  const rollAndPersist = async (doc: { id: string; ref: { update: (d: Record<string, unknown>) => Promise<unknown> }; data: () => unknown }) => {
    if (seen.has(doc.id)) return
    seen.add(doc.id)
    const sub = (doc.data() as WorkspaceDoc).subscription
    if (!sub) return
    const rolled = rollSubscriptionToCurrentPeriod(sub, today)
    if (!rolled.changed) return

    // 降回免費層 → 順手解除那張卡在 PAYUNi 的約定,不留一個沒人會用的授權在金流端
    // （對客戶也是好事:他的卡不再被我們綁著）。
    //
    // ⚠️ 這是**清潔工作,不是安全需求**——PAYUNi 是我方主動發動扣款,`autoRenew=false` 之後
    //    沒有任何排程會扣他。所以解約失敗就**留著 Token、下次對帳再試**,絕不因此中斷對帳。
    //    （對比藍新:不終止委託就會「服務被降級、錢照扣」,那才是必須成功的操作。）
    // ⚠️ 只在「真的降級」時解。客戶按下取消（cancelAtPeriodEnd）時**不解**——他本期還能用,
    //    而且可能反悔想恢復訂閱,那時還需要這組 Token。
    if (rolled.downgraded && rolled.sub.payuniCardToken && payuni?.merchantId) {
      const r = await cancelCardBinding({
        merchantId: payuni.merchantId,
        bindVal: rolled.sub.payuniCardToken,
        timestamp: Math.floor(now.getTime() / 1000),
      }, payuni.keys, payuni.env, payuni.relayBase)
      if (r.ok || r.notFound) {
        delete rolled.sub.payuniCardToken
        delete rolled.sub.payuniCardLast4
        delete rolled.sub.payuniCardExpiry
        unbound++
      }
      else {
        console.warn('[payment] 降級時解除卡片約定失敗,Token 留著下次再試', doc.id, r.outerStatus, r.message)
      }
    }

    await doc.ref.update({ subscription: rolled.sub, updatedAt: FieldValue.serverTimestamp() })
    invalidateWorkspaceSubscriptionCache(doc.id)
    renewed++
    if (rolled.downgraded) downgraded++
  }

  // ① 已過期的訂閱（本期結束日在今天之前）
  const stale = await db.collection('workspaces').where('subscription.currentPeriodEnd', '<', today).get()
  for (const doc of stale.docs) await rollAndPersist(doc)

  // ② past_due 的訂閱 —— **這一段不能省**。
  //    past_due 代表「已經滾進新一期、但這一期還沒收到錢」,所以它的 currentPeriodEnd 是未來日期,
  //    第 ① 段的查詢（currentPeriodEnd < today）**永遠選不到它**。少了這一段,「寬限期滿要降級」
  //    就只會在每次讀訂閱時被就地算出來、從不寫回 Firestore → 資料永遠停在
  //    past_due + autoRenew + Token → 續扣排程每天都選到它,同一張被拒的卡被無限重扣。
  const pastDue = await db.collection('workspaces').where('subscription.status', '==', 'past_due').get()
  for (const doc of pastDue.docs) await rollAndPersist(doc)

  let expiredOrders = 0
  const pending = await db.collection(PAYMENT_ORDERS_COLLECTION).where('status', '==', 'pending').get()
  for (const doc of pending.docs) {
    const order = doc.data() as PaymentOrderDoc
    // 續扣單給更長的 TTL（見 STALE_RECURRING_PENDING_MS）
    const ttl = order.kind === 'period_recurring' ? STALE_RECURRING_PENDING_MS : STALE_PENDING_MS
    const staleCutoffMs = now.getTime() - ttl
    const createdAt = order.createdAt as Timestamp
    const ms = createdAt && typeof createdAt.toMillis === 'function' ? createdAt.toMillis() : 0
    if (ms && ms < staleCutoffMs) {
      await doc.ref.update({ status: 'expired' as PaymentOrderStatus, updatedAt: FieldValue.serverTimestamp() })
      expiredOrders++
    }
  }

  return { renewed, downgraded, unbound, expiredOrders }
}
