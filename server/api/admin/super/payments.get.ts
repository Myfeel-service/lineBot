import type { Timestamp } from 'firebase-admin/firestore'
import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { PAYMENT_ORDERS_COLLECTION, summarizePaymentMonth } from '~~/server/utils/payment'
import { taipeiYyyyMm } from '~~/shared/time'
import type { PaymentOrderDoc } from '~~/shared/types/payment'
import type { WorkspaceDoc } from '~~/shared/types/organization'

/**
 * GET /api/admin/super/payments — 本租戶所有官方帳號的付款總覽。僅 super admin。
 * 最近 200 筆訂單 + 本月營收摘要（台灣時區當月已付款,**扣掉已記的人工退款**）。
 * paymentOrders 是「租戶內」top-level collection → 跨租戶各自部署各看各的（與計費設計一致）。
 * 本月營收只從最近 200 筆估;單月成交量將破 200 時要改成用 where 查當月（現階段夠用）。
 */
export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)
  const db = getDb()
  const toMs = (t: unknown) => (t && typeof (t as Timestamp).toMillis === 'function' ? (t as Timestamp).toMillis() : null)

  const snap = await db.collection(PAYMENT_ORDERS_COLLECTION)
    .orderBy('createdAt', 'desc')
    .limit(200)
    .get()
  const docs = snap.docs.map(d => d.data() as PaymentOrderDoc)

  // 補官方帳號名稱（去重後批次讀，避免逐列 N 次讀）
  const wsIds = [...new Set(docs.map(o => o.workspaceId).filter(Boolean))]
  const names = new Map<string, string>()
  await Promise.all(wsIds.map(async (id) => {
    const w = await db.collection('workspaces').doc(id).get()
    if (w.exists) names.set(id, (w.data() as WorkspaceDoc).name || id)
  }))

  const orders = docs.map(o => ({
    merchantOrderNo: o.merchantOrderNo,
    workspaceId: o.workspaceId,
    workspaceName: names.get(o.workspaceId) || o.workspaceId,
    planId: o.planId,
    amount: o.amount,
    status: o.status,
    paymentType: o.paymentType ?? null,
    createdAt: toMs(o.createdAt),
    paidAt: toMs(o.paidAt),
    invoiceNumber: o.invoiceNumber ?? null,
    invoiceStatus: o.invoiceStatus ?? null,
    // 列表直接標「已折讓／已退款」,不用逐筆 join invoices/billingRefunds
    invoiceAllowanceTotal: o.invoiceAllowanceTotal ?? null,
    manualRefundTotal: o.manualRefundTotal ?? null,
  }))

  // 算式在 payment.ts（純函式、有測試）——這是拿去對帳的數字,不能只靠看畫面驗。
  const thisMonth = taipeiYyyyMm(new Date())
  const month = summarizePaymentMonth(orders, thisMonth)
  const pendingCount = orders.filter(o => o.status === 'pending').length

  // 發票未開成的真實數量:用 count() 掃**整個** collection,不受最近 200 筆限制——
  // 客戶端把 failed 顯示成「開立中」(2026-08-16 拍板),所以超管這裡必須看得到真實狀態,
  // 否則就變成雙面都綠的假綠燈,沒有人知道發票在積壓。
  const failedAgg = await db.collection(PAYMENT_ORDERS_COLLECTION)
    .where('invoiceStatus', '==', 'failed')
    .count()
    .get()
  const invoiceFailedCount = failedAgg.data().count

  // month 已含 monthRevenue(淨額) 與 monthCharged / monthRefunded——
  // 算式兩端要一起回,否則畫面上的 NT$0 看起來像壞掉,而不是「退光了」。
  return {
    orders,
    summary: { thisMonth, ...month, pendingCount, invoiceFailedCount, count: orders.length },
  }
})
