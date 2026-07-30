import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { BILLING_PLAN_ORDER, getBillingPlan } from '~~/shared/billing/plans'
import type { BillingPlanId } from '~~/shared/billing/plans'
import { PAYUNI_ENDPOINTS, PAYUNI_UPP_TOKEN_VERSION, PAYUNI_UPP_VERSION, buildTokenBindFields, buildUppForm, resolvePayuniEnv } from '~~/server/utils/payuni'
import { createPendingOrder, findRecentPendingOrder, newMerchantOrderNo, supersedePendingOrders } from '~~/server/utils/payment'
import type { WorkspaceDoc } from '~~/shared/types/organization'
import { POLICY_VERSION } from '~~/shared/legal'
import { dayOfDate, taipeiDate } from '~~/shared/time'

/**
 * POST /api/payment/create-order
 * body: { workspaceId, planId }
 *
 * 建立一筆 pending 訂單,回傳 PAYUNi 統一金流 整合式支付頁(UPP)自動送出表單所需欄位。
 * 金額由後端依方案表決定(不信前端傳值);免費 / 客製方案不支援線上結帳。
 * 需 admin(帳號管理員 / 組織管理員 / super admin)。
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
  // 「不適用七日猶豫期」的法律前提是**付款前**取得同意（見 shared/legal.ts）——
  // 前端沒帶同意就不建單、不導去金流,免得事後拿不出同意紀錄。
  // 版本號由後端蓋成現行 POLICY_VERSION,不採信前端傳來的版本。
  if (body?.termsAccepted !== true) {
    throw createError({ statusCode: 400, statusMessage: '請先勾選同意服務條款與退費政策' })
  }

  const config = useRuntimeConfig(event)
  const brandName = String(config.public.brandName || '').trim()
  const merchantId = String(config.payuniMerchantId || '').trim()
  const base = String(config.appBaseUrl || '').trim().replace(/\/$/, '')
  if (!merchantId || !config.payuniHashKey || !config.payuniHashIV) {
    throw createError({ statusCode: 500, statusMessage: '金流尚未設定' })
  }
  if (!base) {
    throw createError({ statusCode: 500, statusMessage: '未設定對外網址(PUBLIC_BASE_URL)' })
  }

  const db = getDb()
  const wsSnap = await db.collection('workspaces').doc(workspaceId).get()
  if (!wsSnap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此官方帳號' })
  const organizationId = (wsSnap.data() as WorkspaceDoc).organizationId ?? null

  // 自動扣款開關(灰度):開了才在首刷向 PAYUNi 建立信用卡約定、拿 Token 供每期幕後續扣。
  // 關著 = 現行單次付款,行為一行不變(見 docs/PAYUNI-RECURRING-DESIGN.md)。
  const bindCard = config.payuniPeriodEnabled === true
  const kind = bindCard ? 'period_first' as const : 'one_time' as const
  const now = new Date()

  // 去重:同帳號、同方案、**同 kind** 近 30 分鐘內已有 pending 訂單 → 沿用同一單號
  // (連點/雙分頁不重複扣款)。kind 要比對,否則旗標切換前後的舊單會被沿用成錯的型態。
  const existing = await findRecentPendingOrder(workspaceId, planId, now, db, kind)
  // 作廢此帳號其它待付款(換方案/放棄的舊單) → 帳單頁只留一筆進行中;保留要沿用的 existing。
  await supersedePendingOrders(workspaceId, existing?.merchantOrderNo ?? null, db)
  const amount = existing?.amount ?? plan.priceMonthly
  const merchantOrderNo = existing?.merchantOrderNo ?? newMerchantOrderNo(now)
  if (!existing) {
    await createPendingOrder({
      merchantOrderNo,
      workspaceId,
      organizationId,
      planId,
      amount,
      createdBy: uid,
      termsVersion: POLICY_VERSION,
      kind,
      // 錨定日在**建單當下**定好、開通時沿用不重算:跨午夜建單(23:59 建、00:00 開通)
      // 會讓續扣日與續期日差一天,每個月都在寬限期的縫隙裡把付費客戶降級。
      anchorDay: bindCard ? dayOfDate(taipeiDate(now)) : null,
    }, db)
  }

  const keys = { merKey: String(config.payuniHashKey), merIV: String(config.payuniHashIV) }
  const encryptInfo: Record<string, string | number> = {
    MerID: merchantId,
    MerTradeNo: merchantOrderNo,
    TradeAmt: amount,
    Timestamp: Math.floor(Date.now() / 1000),
    // 商品描述要帶產品名:客戶在 PAYUNi 付款頁與信用卡帳單上看到的就是這一行,
    // 風控也會拿它跟申報的商品名稱核對(見 nuxt.config 的 brandName)。
    ProdDesc: bindCard
      ? `${brandName} ${plan.name}方案 月訂閱(每月自動扣款)`.trim()
      : `${brandName} ${plan.name}方案(1 個月)`.trim(),
    NotifyURL: `${base}/payuni/notify`,
    ReturnURL: `${base}/payuni/return?ws=${encodeURIComponent(workspaceId)}&no=${merchantOrderNo}`,
  }
  const email = String(token.email || '').trim()
  if (email) encryptInfo.UsrMail = email
  // 首刷建立約定:多帶 Credit / UseTokenType / CreditToken / CreditTokenType,
  // 且 UPP 版本要 2.0 才會在回應帶回 CreditHash（見 payuni.ts 版本註解）。
  if (bindCard) Object.assign(encryptInfo, buildTokenBindFields(workspaceId))

  const env = resolvePayuniEnv(config.payuniEnv)
  const fields = buildUppForm(encryptInfo, keys, bindCard ? PAYUNI_UPP_TOKEN_VERSION : PAYUNI_UPP_VERSION)

  // 前端據此建 hidden form 自動 POST 到 action（fields = { MerID, Version, EncryptInfo, HashInfo }）
  return {
    merchantOrderNo,
    action: PAYUNI_ENDPOINTS[env],
    method: 'POST',
    fields,
  }
})
