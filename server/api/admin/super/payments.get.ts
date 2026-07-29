import type { Timestamp } from 'firebase-admin/firestore'
import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { PAYMENT_ORDERS_COLLECTION } from '~~/server/utils/payment'
import { taipeiYyyyMm } from '~~/shared/time'
import type { PaymentOrderDoc } from '~~/shared/types/payment'
import type { WorkspaceDoc } from '~~/shared/types/organization'

/**
 * GET /api/admin/super/payments — 本租戶所有官方帳號的付款總覽。僅 super admin。
 * 最近 200 筆訂單 + 本月營收摘要（台灣時區當月已付款）。
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
  }))

  const thisMonth = taipeiYyyyMm(new Date())
  let monthRevenue = 0
  let monthPaidCount = 0
  let monthFailedCount = 0
  for (const o of orders) {
    const when = o.paidAt ?? o.createdAt
    if (when == null || taipeiYyyyMm(new Date(when)) !== thisMonth) continue
    if (o.status === 'paid') {
      monthRevenue += o.amount || 0
      monthPaidCount++
    }
    else if (o.status === 'failed') {
      monthFailedCount++
    }
  }
  const pendingCount = orders.filter(o => o.status === 'pending').length

  return { orders, summary: { thisMonth, monthRevenue, monthPaidCount, monthFailedCount, pendingCount, count: orders.length } }
})
