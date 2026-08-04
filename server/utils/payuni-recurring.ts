/**
 * PAYUNi 每期自動續扣（幕後 Token 扣款）——P3 + P4（降級期末生效 / 折抵）。
 *
 * ── 為什麼是「我方主動扣」──────────────────────────────────────────────────
 * PAYUNi 的自動扣款不是「金流按自己的排程扣固定金額」,而是首刷拿到一組信用卡 Token
 * （CreditHash）,之後**每期由我方**打 /api/credit 扣款、**金額每期自訂**。代價是排程責任
 * 在我方;好處是失敗方向安全——排程沒跑 = 這期沒扣到（頂多少收錢）,不會變成
 * 「服務停了、卡卻一直被扣」那種爭議款。金額每期可變也讓折抵／降級只是「這期少扣一點」。
 *
 * ── 誰該被扣 ───────────────────────────────────────────────────────────────
 * 到期時 `rollSubscriptionToCurrentPeriod` 已經把自動續訂的訂閱**滾進新一期並標 past_due**
 * （額度照給、服務照跑,見 shared/billing/period.ts）。所以「該扣款的人」就是
 * past_due + autoRenew + 未按取消 + 有 Token + 還在自助付費方案上。
 * 扣款成功 → confirmRenewal 把**這一期**確認為 active（不是再開一期,那會變兩個月）。
 * 一直失敗 → 寬限期（GRACE_DAYS=3）滿了就降回免費層。
 * ⚠️ 降級的**落地**靠 `runPaymentReconcile` 掃 `status=='past_due'` 那一段（它的第 ① 段用
 *    `currentPeriodEnd < today` 查,永遠選不到已滾進新一期的 past_due）。這裡的
 *    `isDueForRecurringCharge` 另有一道寬限期檢查當第二道保險——兩者缺一,被拒的卡就會天天重扣。
 *
 * ── 三層防重複扣款 ─────────────────────────────────────────────────────────
 *  ① claim：transaction 內把 `lastChargeDate` 寫成今天,另一路（cron / middleware tick）
 *     看到就跳過。同一天只會有一次嘗試。
 *  ② 訂單冪等鍵：單號由 (workspaceId, 本期起日, 嘗試日) 決定,`create()` 撞到即跳過。
 *  ③ 狀態：扣成功後 status → active,下一輪查詢就不會再選到它。
 *
 * ── UNKNOWN 不是失敗 ───────────────────────────────────────────────────────
 * 銀行 60 秒沒回 → PAYUNi 先回 UNKNOWN,之後才有結果。這時**訂單留 pending、不標失敗、
 * 不重扣**,交給 reconcilePayuniPending 用 trade/query 補查（走與 Notify 相同的開通路徑）。
 * 當成失敗去重扣 = 可能扣兩次。
 *
 * ── 降級與折抵都只是「這期扣的數字不一樣」（P4）─────────────────────────────
 * 下一期的方案與金額由 `resolveRecurringCharge`（shared/billing/recurring.ts）算出：
 * 方案 = `pendingPlanId ?? planId`（降級期末生效）、金額 = 月費 − min(折抵餘額, 月費)。
 * 折抵把整期蓋滿時**不呼叫金流**（0 元請款會被退）,直接續期且不開發票——那筆錢先前已收過、
 * 也已開過發票了。方案變更與折抵的落地（清 pendingPlanId、扣餘額）在 settlePaidOrder 內,
 * 且以**訂單上的值**為準,所以重試／查單補救走同一條路不會重複扣餘額。
 */
import { FieldValue } from 'firebase-admin/firestore'
import type { Firestore } from 'firebase-admin/firestore'
import { getDb } from './firebase'
import { createPendingOrder, settlePaidOrder, PAYMENT_ORDERS_COLLECTION } from './payment'
import { assertPayuniKeys, chargeCreditToken, isCreditChargeIndeterminate, type PayuniKeys } from './payuni'
import { fulfillPayuniTrade } from './payuni-fulfill'
import { sendChargeFailedNotification, sendReceiptNotification } from './billing-emails'
import { GRACE_DAYS } from '~~/shared/billing/period'
import { resolveRecurringCharge } from '~~/shared/billing/recurring'
import { getBillingPlan, isSelfServePaidPlan, type WorkspaceSubscription } from '~~/shared/billing/plans'
import { addDays, taipeiDate } from '~~/shared/time'
import type { WorkspaceDoc } from '~~/shared/types/organization'
import type { PaymentOrderDoc } from '~~/shared/types/payment'

/** 一輪最多扣幾筆（避免 backlog 一次打爆 PAYUNi 與 Lambda 時限）。 */
const MAX_CHARGES_PER_RUN = 50

export interface RecurringChargeSummary {
  /** 掃到幾筆「看起來該扣」的訂閱 */
  due: number
  /** 扣款成功並續期 */
  charged: number
  /** 折抵把整期蓋滿 → 沒有信用卡交易,直接續期 */
  covered: number
  /** 扣款失敗（卡片被拒等）→ 留在 past_due 等明天重試 */
  failed: number
  /** PAYUNi 回 UNKNOWN → 留 pending 待查,不重扣 */
  unknown: number
  /** 今天已試過 / 搶不到 claim / 方案不支援 → 跳過 */
  skipped: number
}

/** FNV-1a → 6 碼 base36。純函式,用來把 workspaceId 壓進單號長度預算。 */
function shortHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).toUpperCase().padStart(6, '0').slice(-6)
}

/** YYYY-MM-DD → YYMMDD */
function ymd6(date: string): string {
  return date.slice(2).replace(/-/g, '')
}

/**
 * 續扣的商店訂單編號（= 帳本 doc id = 冪等鍵）。
 *
 * `R` + workspace 短雜湊(6) + 本期起日(6) + 嘗試日(6) = **19 碼**,純大寫英數。
 * 長度預算被「發票自訂編號 ≤20 碼」綁死（`/api/credit` 的 MerTradeNo 上限 25 更寬鬆）。
 *
 * 同一個帳號、同一期、同一天 → 同一個單號 → `create()` 會撞,天然擋掉重複扣款；
 * 隔天重試會拿到不同單號（PAYUNi 要求 MerTradeNo 10 分鐘內不得重複,隔日自然滿足）。
 *
 * ⚠️ 雜湊碰撞（36^6 ≈ 22 億分之一）的後果是「另一個帳號今天扣不到,並留下 log」——
 *    刻意選這個方向：寧可漏扣一次,不要重複扣款。
 */
export function recurringOrderNo(workspaceId: string, periodStart: string, attemptDate: string): string {
  return `R${shortHash(workspaceId)}${ymd6(periodStart)}${ymd6(attemptDate)}`
}

/**
 * 這筆訂閱現在該不該被自動續扣。
 *
 * 純函式,好測也好講：**只有 roll 已經把它推進新一期、標成 past_due 的自動續訂才算 due**。
 * active 的不扣（本期已付）、按過取消的不扣、沒 Token 的不扣（扣不了）、
 * 免費／企業／內部方案不扣（沒有月費或走合約）。
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

/**
 * 搶下「今天由我來扣這個帳號」的權利。
 *
 * 在 transaction 內重讀訂閱再判定一次（避免與另一路排程／剛完成的付款競態），
 * 成功就把 `lastChargeDate` 寫成今天並累加本期嘗試次數。回 null = 別扣。
 */
async function claimCharge(
  workspaceId: string,
  today: string,
  db: Firestore,
): Promise<WorkspaceSubscription | null> {
  const wsRef = db.collection('workspaces').doc(workspaceId)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(wsRef)
    if (!snap.exists) return null
    const sub = (snap.data() as WorkspaceDoc).subscription
    if (!isDueForRecurringCharge(sub, today)) return null

    const samePeriod = sub!.chargePeriodStart === sub!.currentPeriodStart
    const next: WorkspaceSubscription = {
      ...sub!,
      lastChargeDate: today,
      chargePeriodStart: sub!.currentPeriodStart,
      chargeAttempts: (samePeriod ? (sub!.chargeAttempts ?? 0) : 0) + 1,
    }
    tx.update(wsRef, { subscription: next, updatedAt: FieldValue.serverTimestamp() })
    return next
  })
}

/**
 * 這個帳號還有沒有「結果未定」的續扣單。
 *
 * 只要還有一筆 `period_recurring` 停在 `pending`,就代表上一次嘗試**還沒拿到答案**
 * （PAYUNi 回 UNKNOWN／逾時,等 `reconcilePayuniPending` 用 trade/query 補查）。
 * 這時**絕不能再扣一次**:續扣單號刻意把「嘗試日」編進去,所以隔天會產生不同的
 * `MerTradeNo` → 冪等鍵擋不住 → 兩筆授權可能同時成立,客戶同一期被扣兩次。
 *
 * 查詢失敗時**保守回 true**（寧可漏扣一次,不要重複扣款）。
 */
async function hasUnresolvedRecurringOrder(workspaceId: string, db: Firestore): Promise<boolean> {
  try {
    const snap = await db.collection(PAYMENT_ORDERS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .where('status', '==', 'pending')
      .get()
    return snap.docs.some(d => (d.data() as PaymentOrderDoc).kind === 'period_recurring')
  }
  catch (e) {
    console.warn('[payuni:recurring] 查未決續扣單失敗,保守跳過本次扣款', workspaceId, (e as Error)?.message)
    return true
  }
}

/**
 * 把失敗原因寫回訂閱（給客戶與客服看）。狀態維持 past_due——降級一律交給 roll。
 *
 * ⚠️ **只更新 `subscription.lastChargeError` 這一個欄位**（點狀路徑）,不可「讀出整個
 *    subscription → 展開 → 寫回去」。那種寫法會把讀取後、寫入前發生的任何變更覆蓋掉:
 *    客戶在這 0.5 秒內按了「取消訂閱」,就會被這行悄悄還原成 autoRenew=true,隔天再扣一次。
 */
async function recordChargeError(workspaceId: string, message: string, db: Firestore): Promise<void> {
  try {
    await db.collection('workspaces').doc(workspaceId).update({
      'subscription.lastChargeError': message.slice(0, 200),
      'updatedAt': FieldValue.serverTimestamp(),
    })
  }
  catch (e) {
    console.warn('[payuni:recurring] 寫回失敗原因失敗（不影響扣款結果）', workspaceId, (e as Error)?.message)
  }
}

/**
 * 掃出到期未付的自動續訂訂閱,逐筆幕後扣款。
 *
 * 必須在 `runPaymentReconcile`（負責 roll → 標 past_due）**之後**呼叫,
 * 見 run-billing-reconcile.ts 的順序註解。金流未設定 / 旗標未開 → 直接回 0，零副作用。
 */
export async function chargeDueRecurring(
  config: Record<string, unknown>,
  now: Date = new Date(),
  db: Firestore = getDb(),
): Promise<RecurringChargeSummary> {
  const empty: RecurringChargeSummary = { due: 0, charged: 0, covered: 0, failed: 0, unknown: 0, skipped: 0 }
  if (config.payuniPeriodEnabled !== true) return empty

  const merchantId = String(config.payuniMerchantId || '').trim()
  const keys: PayuniKeys = { merKey: String(config.payuniHashKey || ''), merIV: String(config.payuniHashIV || '') }
  if (!merchantId || !keys.merKey || !keys.merIV) return empty

  // 金鑰長度**先驗一次**再進迴圈。少了這道,設定錯誤（例如 IV 少一碼）會在每個帳號的
  // 扣款呼叫裡才 throw,被歸類成「結果未定」,而 claim 已經把當天唯一一次嘗試燒掉 →
  // 所有自動續訂客戶都不會有失敗信、也查不到任何訂單,3 天後全部靜默降級。
  // 這裡直接整輪中止並大聲報錯:寧可這期沒扣到,也不要無聲無息把付費客戶降級。
  try {
    assertPayuniKeys(keys)
  }
  catch (e) {
    console.error('[payuni:recurring] PAYUNi 金鑰設定有誤,整輪續扣中止（不會有人被扣款也不會被誤降級）:', (e as Error)?.message)
    return empty
  }

  const today = taipeiDate(now)
  const brandName = String((config.public as Record<string, unknown> | undefined)?.brandName || '').trim()

  // past_due 是「已滾進新一期但還沒收到錢」的唯一狀態 → 用它當查詢條件（單欄索引即可）。
  const snap = await db.collection('workspaces').where('subscription.status', '==', 'past_due').get()
  const summary = { ...empty }

  for (const doc of snap.docs) {
    if (summary.charged + summary.covered + summary.failed + summary.unknown >= MAX_CHARGES_PER_RUN) {
      console.warn('[payuni:recurring] 已達單輪上限,其餘留到下一輪', MAX_CHARGES_PER_RUN)
      break
    }
    const raw = (doc.data() as WorkspaceDoc).subscription
    if (!isDueForRecurringCharge(raw, today)) continue
    summary.due++

    // 單筆失敗不得炸掉整輪:這支跑在 runBillingReconcile 中間,拋出去會讓後面的
    // 「補開發票」「通知信」階段對**所有人**都不執行。
    try {
      // ①-a 上一次嘗試還沒有結果 → 這輪不扣（見 hasUnresolvedRecurringOrder）
      if (await hasUnresolvedRecurringOrder(doc.id, db)) {
        console.warn('[payuni:recurring] 仍有未決的續扣單,本輪跳過以免重複扣款', doc.id)
        summary.skipped++
        continue
      }

      // ①-b 搶 claim（transaction 內再判一次）
      const sub = await claimCharge(doc.id, today, db)
      if (!sub) { summary.skipped++; continue }

      // 下一期的方案（降級排程在此生效）與金額（先折抵）——規則在 shared/billing/recurring.ts,
      // 帳單頁顯示「下期會扣多少」讀的是同一支,兩邊不會各說各話。
      const charge = resolveRecurringCharge(sub)
      const plan = getBillingPlan(charge.planId)
      const amount = charge.amount
      const periodStart = sub.currentPeriodStart!
      const merchantOrderNo = recurringOrderNo(doc.id, periodStart, today)

      try {
        // ② 建本期帳（doc id = 冪等鍵；已存在 → create() 丟錯 → 這輪跳過,不扣款）
        await createPendingOrder({
          merchantOrderNo,
          workspaceId: doc.id,
          organizationId: (doc.data() as WorkspaceDoc).organizationId ?? null,
          planId: charge.planId,
          amount,
          kind: 'period_recurring',
          anchorDay: sub.anchorDay ?? null,
          creditApplied: charge.creditUsed,
        }, db)
      }
      catch (e) {
        // ALREADY_EXISTS = 這期這天已經有人建過單（重跑 / 雜湊碰撞）→ 安全跳過
        console.warn('[payuni:recurring] 本期帳已存在,跳過扣款', doc.id, merchantOrderNo, (e as Error)?.message)
        summary.skipped++
        continue
      }

      // ②-b 折抵把整期蓋滿 → **不呼叫金流**。金流不接受 0 元請款,硬送會被退;
      //      而且這期本來就沒有新的一筆錢要收（折抵來自先前已收並已開過發票的款項）,
      //      所以也不開發票（訂單記 skipped + 原因）,稅務上乾淨。
      if (charge.fullyCovered) {
        const settled = await settlePaidOrder({
          merchantOrderNo,
          paid: true,
          amount,
          paymentType: 'CREDIT_BALANCE',
          now,
        }, db)
        if (settled.outcome === 'settled') {
          await db.collection(PAYMENT_ORDERS_COLLECTION).doc(merchantOrderNo).update({
            invoiceStatus: 'skipped',
            failReason: null,
            notifyRaw: { source: 'credit_balance', creditUsed: charge.creditUsed },
          })
          summary.covered++
          console.log('[payuni:recurring] 本期由折抵全額支付,未向信用卡請款', doc.id, merchantOrderNo, charge.creditUsed)
          // ⚠️ 這條路沒經過 fulfillPayuniTrade（收據信是在那支寄的）→ 要自己寄一封,
          //    否則「這期沒扣款」對客戶完全靜默,他會以為訂閱斷了。
          //    收據會顯示「折抵餘額支付（未扣卡）」,不會寫成「付款成功 NT$0」。
          await sendReceiptNotification(merchantOrderNo)
        }
        else {
          summary.skipped++
          console.warn('[payuni:recurring] 折抵支付結算未成立', doc.id, merchantOrderNo, settled.outcome)
        }
        continue
      }

      // ③ 幕後扣款（同步拿結果,不像藍新要等 webhook）
      let authz: Awaited<ReturnType<typeof chargeCreditToken>>
      try {
        authz = await chargeCreditToken({
          merchantId,
          merchantOrderNo,
          tradeAmt: amount,
          creditHash: sub.payuniCardToken!,
          prodDesc: `${brandName} ${plan.name}方案 訂閱續扣`.trim(),
          timestamp: Math.floor(now.getTime() / 1000),
        }, keys, config.payuniEnv)
      }
      catch (e) {
        // 網路層失敗：結果未知 → 與 UNKNOWN 同樣處理（留 pending,不標失敗、不重扣）
        console.error('[payuni:recurring] 扣款呼叫失敗,結果未知,留待查單', doc.id, merchantOrderNo, (e as Error)?.message)
        summary.unknown++
        continue
      }

      // 結果未定（UNKNOWN／TradeStatus=8 待確認／HTTP 逾時…）→ 既非成功也非失敗。
      // 留 pending 給 reconcilePayuniPending 用 trade/query 補查,**絕不標失敗、絕不重扣**
      // （標了 failed 就是終態,銀行事後核准也再也結算不了——見 isCreditChargeIndeterminate）。
      if (!authz.ok && isCreditChargeIndeterminate(authz)) {
        console.warn('[payuni:recurring] 扣款結果未定,留待 trade/query 補查', doc.id, merchantOrderNo, authz.outerStatus, authz.result?.TradeStatus ?? '')
        summary.unknown++
        continue
      }

      // ④ 結算：與 Notify／查單補救走**完全相同**的路徑（開通 + 開發票 + 收據信）
      const result = { ...(authz.result ?? {}), MerTradeNo: merchantOrderNo }
      const r = await fulfillPayuniTrade(authz.ok, result, config)

      if (authz.ok && r.outcome === 'settled' && !r.amountMismatch) {
        summary.charged++
        console.log('[payuni:recurring] 續扣成功', doc.id, merchantOrderNo, amount)
        continue
      }

      summary.failed++
      const message = String(authz.result?.Message || authz.outerStatus || '扣款未成功')
      console.warn('[payuni:recurring] 續扣失敗', doc.id, merchantOrderNo, authz.outerStatus, message)
      await recordChargeError(doc.id, message, db)
      // 首次失敗才寄提醒（第 1 次嘗試）——每天重試都寄會變騷擾。
      if (sub.chargeAttempts === 1) {
        await sendChargeFailedNotification({ workspaceId: doc.id, planId: charge.planId }, db)
      }
    }
    catch (e) {
      summary.skipped++
      console.error('[payuni:recurring] 單筆續扣流程異常,跳過此帳號繼續跑', doc.id, (e as Error)?.message)
    }
  }

  return summary
}
