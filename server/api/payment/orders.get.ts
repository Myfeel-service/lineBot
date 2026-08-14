import type { Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { PAYMENT_ORDERS_COLLECTION } from '~~/server/utils/payment'
import type { PaymentOrderDoc } from '~~/shared/types/payment'

/**
 * GET /api/payment/orders — 列出本帳號的付款訂單(近 50 筆,新到舊)。需 admin。
 * 用 (workspaceId ASC, createdAt DESC) composite index 直接取最新 50 筆
 * (見 firestore.indexes.json;index 未部署時會丟錯,billing 頁 catch 後顯示空表)。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'admin')
  const db = getDb()
  const toMs = (t: unknown) => (t && typeof (t as Timestamp).toMillis === 'function' ? (t as Timestamp).toMillis() : null)
  try {
    const snap = await db.collection(PAYMENT_ORDERS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get()
    return snap.docs.map((d) => {
      const o = d.data() as PaymentOrderDoc
      return {
        merchantOrderNo: o.merchantOrderNo,
        planId: o.planId,
        amount: o.amount,
        status: o.status,
        paymentType: o.paymentType ?? null,
        failReason: o.failReason ?? null,
        createdAt: toMs(o.createdAt),
        paidAt: toMs(o.paidAt),
        invoiceNumber: o.invoiceNumber ?? null,
        invoiceStatus: o.invoiceStatus ?? null,
        invoiceAllowanceTotal: o.invoiceAllowanceTotal ?? null,
      }
    })
  }
  catch (e) {
    // 多半是 (workspaceId, createdAt) composite index 尚未部署(見 firestore.indexes.json)
    // → 退化成空清單,不讓帳單頁 500;部署索引後即正常。
    console.warn('[payment] orders 查詢失敗,可能是 composite index 未部署:', (e as Error)?.message)
    return []
  }
})
