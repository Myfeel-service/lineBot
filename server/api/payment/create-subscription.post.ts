import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { BILLING_PLAN_ORDER, getBillingPlan } from '~~/shared/billing/plans'
import type { BillingPlanId } from '~~/shared/billing/plans'
import { buildPeriodPostData } from '~~/server/utils/newebpay'
import { createPendingOrder, findRecentPendingOrder, newMerchantOrderNo } from '~~/server/utils/payment'
import { getWorkspaceSubscription } from '~~/server/utils/billing'
import { dayOfDate, taipeiDate } from '~~/shared/time'
import type { WorkspaceDoc } from '~~/shared/types/organization'
import { POLICY_VERSION } from '~~/shared/legal'

/**
 * POST /api/payment/create-subscription
 * body: { workspaceId, planId }
 *
 * 建立藍新「信用卡定期定額委託」(NPA-B05) —— 客戶刷一次卡，之後每月自動扣款。
 * 回傳前端要自動 POST 到藍新的表單欄位（MerchantID_ / PostData_，**沒有 TradeSha**）。
 *
 * 週期對齊我方的錨定日：`PeriodPoint` = 今天幾號 = 訂閱的 anchorDay。藍新對短月的
 * 夾法（沒有 31 號就扣月底）與 shared/time.ts 的 anchoredPeriod 相同,兩邊的續期日
 * 因此永遠對得起來。
 *
 * `PeriodStartType=2`：委託成立當下立刻扣一期全額——客戶當場就拿到完整一期,
 * 首期不折算天數（這正是錨定日制的意義）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid, token } = await requireWorkspaceAccess(event, 'admin')
  const body = await readBody(event)
  const planId = String(body?.planId || '') as BillingPlanId

  if (!BILLING_PLAN_ORDER.includes(planId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid planId' })
  }
  const plan = getBillingPlan(planId)
  if (plan.custom || plan.priceMonthly == null || plan.priceMonthly <= 0) {
    throw createError({ statusCode: 400, statusMessage: '此方案不支援線上結帳,請聯繫業務' })
  }
  // 同 create-order：沒有付款前的同意紀錄就不建單（見 shared/legal.ts）。
  // 自動續訂更需要這一筆——「授權往後每個月扣款」正是最容易變成爭議款的環節。
  if (body?.termsAccepted !== true) {
    throw createError({ statusCode: 400, statusMessage: '請先勾選同意服務條款與退費政策' })
  }

  const config = useRuntimeConfig(event)
  const merchantId = String(config.newebpayMerchantId || '').trim()
  const base = String(config.appBaseUrl || '').trim().replace(/\/$/, '')
  if (!merchantId || !config.newebpayHashKey || !config.newebpayHashIV) {
    throw createError({ statusCode: 500, statusMessage: '金流尚未設定' })
  }
  if (!config.newebpayPeriodEnabled) {
    throw createError({ statusCode: 400, statusMessage: '自動續訂尚未開通,請改用單次付款' })
  }
  if (!base) {
    throw createError({ statusCode: 500, statusMessage: '未設定對外網址(PUBLIC_BASE_URL)' })
  }

  // PayerEmail 是藍新的必填欄位；空值會讓委託在藍新端被退，客戶只會看到一個看不懂的
  // 錯誤頁。寧可在這裡就講清楚。
  const payerEmail = String(token.email || '').trim()
  if (!payerEmail) {
    throw createError({ statusCode: 400, statusMessage: '此帳號沒有 Email，無法建立自動扣款委託' })
  }

  const db = getDb()
  const wsSnap = await db.collection('workspaces').doc(workspaceId).get()
  if (!wsSnap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此官方帳號' })
  const organizationId = (wsSnap.data() as WorkspaceDoc).organizationId ?? null

  // ⚠️ 換方案時**不在這裡終止舊委託**。
  // 建單只是「產生一張要送去藍新的表單」,客戶可能關掉分頁、刷卡失敗、改變主意而從未真的
  // 付款。若此刻就終止舊委託,放棄付款的客戶就白白丟掉他原本還在用的訂閱（下期沒扣款 →
  // 進寬限期 → 降回免費層）。改成把舊委託單號記在訂單上,等**新委託首期扣款成功**
  // （period-notify 收到 SUCCESS）之後才終止舊委託——見 server/routes/newebpay/period-notify.post.ts。
  const currentSub = await getWorkspaceSubscription(workspaceId, db)
  const supersedesPeriodNo = currentSub?.periodNo ?? null
  const supersedesPeriodOrderNo = currentSub?.periodOrderNo ?? null

  const now = new Date()
  // PeriodPoint 需 01–31 兩碼；今天幾號就是錨定日。
  // ⚠️ 這個值必須**跟著訂單存下來**，開通時直接沿用：若開通時重算一次 taipeiDate,
  //    跨午夜建單（23:59 建單、00:00 開通）會讓藍新的扣款日與我方的續期日差一天,
  //    之後每個月都會在「我方到期 → 寬限期 → 藍新還沒扣款」的縫隙裡把客戶降級。
  const anchorDay = dayOfDate(taipeiDate(now))

  // 去重：同帳號同方案近 30 分鐘內的 pending 單沿用同一單號，避免連點建出兩張委託
  const existing = await findRecentPendingOrder(workspaceId, planId, now, db)
  const amount = existing?.amount ?? plan.priceMonthly
  const merchantOrderNo = existing?.merchantOrderNo ?? newMerchantOrderNo(now)
  if (!existing) {
    await createPendingOrder(
      {
        merchantOrderNo, workspaceId, organizationId, planId, amount,
        createdBy: uid, kind: 'period_first', anchorDay, termsVersion: POLICY_VERSION,
        // 開通成功後由 period-notify 拿去終止（現在不動）
        supersedesPeriodNo, supersedesPeriodOrderNo,
      },
      db,
    )
  }

  const keys = { hashKey: String(config.newebpayHashKey), hashIV: String(config.newebpayHashIV) }
  const params: Record<string, string | number> = {
    RespondType: 'JSON',
    TimeStamp: Math.floor(now.getTime() / 1000),
    Version: '1.5',
    LangType: 'zh-Tw',
    MerOrderNo: merchantOrderNo,
    // ProdDesc 僅限中英數、空格、底線——不要放括號等符號，藍新會擋（PER10006）。
    // 帶產品名讓客戶在付款頁／帳單上認得出這筆是什麼（見 nuxt.config 的 brandName）。
    ProdDesc: `${String(config.public.brandName || '').trim()} ${plan.name}方案 每月自動續訂`.trim(),
    PeriodAmt: amount,
    PeriodType: 'M', // 每月
    PeriodPoint: String(existing?.anchorDay ?? anchorDay).padStart(2, '0'),
    PeriodStartType: 2, // 委託成立當下立刻扣一期全額
    PeriodTimes: 99, // 藍新上限就是 99（PER10024）；到期前客戶早就取消或換方案了
    PayerEmail: payerEmail,
    EmailModify: 0, // 不讓客戶在藍新頁面改信箱（要與我方帳號一致）
    PaymentInfo: 'N',
    OrderInfo: 'N',
    NotifyURL: `${base}/newebpay/period-notify`,
    ReturnURL: `${base}/newebpay/return?ws=${encodeURIComponent(workspaceId)}&no=${merchantOrderNo}`,
  }

  return {
    merchantOrderNo,
    action: String(config.newebpayPeriodApiUrl || '').trim(),
    method: 'POST',
    // 定期定額只有這兩個外層欄位，沒有 TradeSha
    fields: { MerchantID_: merchantId, PostData_: buildPeriodPostData(params, keys) },
  }
})
