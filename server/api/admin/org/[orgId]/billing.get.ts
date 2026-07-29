import type { Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireActiveOrgAdmin } from '~~/server/utils/workspace-auth'
import { buildPlanView, defaultFreeSubscription } from '~~/server/utils/billing'
import { PAYMENT_ORDERS_COLLECTION } from '~~/server/utils/payment'
import { getBillingPlan } from '~~/shared/billing/plans'
import { rollSubscriptionToCurrentPeriod } from '~~/shared/billing/period'
import { addDays, taipeiDate } from '~~/shared/time'
import type { WorkspaceDoc } from '~~/shared/types/organization'
import type { PaymentOrderDoc } from '~~/shared/types/payment'

/**
 * GET /api/admin/org/:orgId/billing — 組織的帳務彙總。
 *
 * 計費是掛在「每個官方帳號」上的，但**付錢的通常是組織**。沒有這一頁，一個管 10 個 OA
 * 的代理商就得點進 10 個帳單頁才知道這個月總共要付多少、哪一個要續扣了。
 *
 * 回兩塊：
 *   · `workspaces` —— 每個 OA 的方案、月費、下次扣款日、續訂狀態
 *   · `orders`     —— 整個組織的付款紀錄（跨 OA 合併，新到舊）
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.params?.orgId
  if (!orgId) throw createError({ statusCode: 400, statusMessage: 'orgId is required' })

  await requireActiveOrgAdmin(event, orgId)

  const db = getDb()
  const today = taipeiDate()

  const wsSnap = await db.collection('workspaces').where('organizationId', '==', orgId).get()

  // 每個 OA 只推算一次週期（roll 是純函式但沒必要在 map + reduce 各跑一遍）。
  const rolled = wsSnap.docs.map((doc) => {
    const w = doc.data() as WorkspaceDoc
    const { sub } = rollSubscriptionToCurrentPeriod(w.subscription ?? defaultFreeSubscription(today), today)
    return { id: doc.id, name: w.name ?? doc.id, sub }
  })

  const workspaces = rolled.map(({ id, name, sub }) => {
    const plan = buildPlanView(sub)
    return {
      workspaceId: id,
      name,
      plan,
      // 下次扣款日 = 本期到期日的隔天（藍新在錨定日當天扣款）。沒有自動續訂就沒有下次。
      nextChargeDate: plan?.autoRenew && sub.currentPeriodEnd ? addDays(sub.currentPeriodEnd, 1) : null,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))

  // 下一輪會被扣的總額：只算「還在自動續訂中」的付費方案。
  // 已取消（cancelAtPeriodEnd）與單次付款的不算——它們不會再被扣一次。
  const monthlyTotal = rolled.reduce((sum, { sub }) => {
    if (!sub.autoRenew || sub.cancelAtPeriodEnd) return sum
    return sum + (getBillingPlan(sub.planId).priceMonthly ?? 0)
  }, 0)

  // 跨 OA 的付款紀錄。需要 (organizationId, createdAt) composite index（見 firestore.indexes.json）。
  //
  // ⚠️ 查詢失敗時**不能靜默回空陣列**：前端會渲染出一張看起來很權威的「尚無付款紀錄」空表，
  //    而上面卻寫著「下一輪扣款 NT$3,000」——使用者會以為自己從來沒付過錢。把財務紀錄
  //    靜默降級成「沒有」，比誠實地說「暫時讀不到」糟糕得多。所以回一個明確的錯誤旗標。
  let orders: unknown[] = []
  let ordersError: string | null = null
  try {
    const orderSnap = await db.collection(PAYMENT_ORDERS_COLLECTION)
      .where('organizationId', '==', orgId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get()

    const nameOf = new Map(wsSnap.docs.map(d => [d.id, (d.data() as WorkspaceDoc).name ?? d.id]))
    const toMs = (t: unknown) => (t && typeof (t as Timestamp).toMillis === 'function' ? (t as Timestamp).toMillis() : null)

    orders = orderSnap.docs.map((d) => {
      const o = d.data() as PaymentOrderDoc
      return {
        merchantOrderNo: o.merchantOrderNo,
        workspaceId: o.workspaceId,
        workspaceName: nameOf.get(o.workspaceId) ?? o.workspaceId,
        planId: o.planId,
        amount: o.amount,
        status: o.status,
        createdAt: toMs(o.createdAt),
        invoiceNumber: o.invoiceNumber ?? null,
        invoiceStatus: o.invoiceStatus ?? null,
      }
    })
  }
  catch (e) {
    console.error('[org] 付款紀錄查詢失敗，可能是 (organizationId, createdAt) index 未部署:', (e as Error)?.message)
    ordersError = '付款紀錄暫時讀不到，請稍後再試'
  }

  return { workspaces, monthlyTotal, orders, ordersError }
})
