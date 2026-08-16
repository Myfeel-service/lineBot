import { FieldValue } from 'firebase-admin/firestore'
import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { PAYMENT_ORDERS_COLLECTION } from '~~/server/utils/payment'
import type { PaymentOrderDoc } from '~~/shared/types/payment'

/**
 * POST /api/admin/super/record-refund — 記一筆「已在 PAYUNi 後台完成的人工退款」。僅 super admin。
 * body: { merchantOrderNo, amount, reason }
 *
 * ⚠️ **這支只做紀錄,不打金流**。系統目前沒有退款 API（trade/close 未實作,見 STATUS B-11）,
 * 真退錢是人登入 PAYUNi 商店後台操作——原本系統完全不留痕:發票作廢有紀錄、錢退了沒有,
 * 對帳會斷、也查不到誰退的（2026-08-16 稽核 B-44③）。所以先補上留痕:
 *   · billingRefunds 稽核集合一筆（誰、何時、退多少、為什麼）——與 billingCredits 同構
 *   · 訂單蓋 manualRefundTotal 累計（部分退款可多筆,總額不可超過原請款金額）
 *
 * 發票的稅務動作（作廢／折讓）是另一條路,照舊走 void-invoice／allowance,這裡不代辦——
 * 對話框文案會提醒。日後若實作 trade/close 自動退款,落帳沿用同一組欄位。
 */
export default defineEventHandler(async (event) => {
  const { uid } = await requireSuperAdmin(event)

  const body = await readBody(event)
  const merchantOrderNo = String(body?.merchantOrderNo || '').trim()
  const amount = Math.round(Number(body?.amount))
  const reason = String(body?.reason || '').trim()
  if (!merchantOrderNo) throw createError({ statusCode: 400, statusMessage: '缺少訂單編號' })
  if (!Number.isFinite(amount) || amount < 1) throw createError({ statusCode: 400, statusMessage: '退款金額需為正整數' })
  if (!reason) throw createError({ statusCode: 400, statusMessage: '請填寫原因（會留在稽核紀錄）' })

  const db = getDb()
  const orderRef = db.collection(PAYMENT_ORDERS_COLLECTION).doc(merchantOrderNo)

  // transaction：兩個超管同時記同一筆時,累計不能互蓋、也不能加總超過原金額。
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef)
    if (!snap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此訂單' })
    const order = snap.data() as PaymentOrderDoc
    if (order.status !== 'paid') {
      throw createError({ statusCode: 400, statusMessage: '只有已付款的訂單才能記退款' })
    }
    const before = Math.max(0, Math.floor(order.manualRefundTotal ?? 0))
    const remaining = (order.amount || 0) - before
    if (amount > remaining) {
      throw createError({ statusCode: 400, statusMessage: `退款累計不可超過原請款金額（此單還可記 NT$${remaining.toLocaleString()}）` })
    }
    const after = before + amount

    tx.update(orderRef, { manualRefundTotal: after, updatedAt: FieldValue.serverTimestamp() })
    tx.create(db.collection('billingRefunds').doc(), {
      merchantOrderNo,
      workspaceId: order.workspaceId,
      organizationId: order.organizationId ?? null,
      amount,
      refundTotalBefore: before,
      refundTotalAfter: after,
      reason,
      recordedBy: uid,
      createdAt: FieldValue.serverTimestamp(),
    })
    return { before, after }
  })

  console.log('[payment] 記人工退款', merchantOrderNo, `${result.before} → ${result.after}`, reason)
  return { ok: true, ...result }
})
