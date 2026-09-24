import { voidPendingOrder } from '~~/server/utils/payment'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/payment/void-order
 * body: { workspaceId, merchantOrderNo }
 *
 * 使用者在帳單頁把一筆「待付款」訂單取消（標記逾期）。只能取消自己帳號、且仍是 pending 的單。
 * 需 admin。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'admin')
  const body = await readBody(event)
  const merchantOrderNo = String(body?.merchantOrderNo || '').trim()
  if (!merchantOrderNo) {
    throw createError({ statusCode: 400, statusMessage: 'missing merchantOrderNo' })
  }

  const r = await voidPendingOrder(merchantOrderNo, workspaceId)
  if (r === 'not_found') throw createError({ statusCode: 404, statusMessage: '找不到此訂單' })
  if (r === 'forbidden') throw createError({ statusCode: 403, statusMessage: '無權操作此訂單' })
  if (r === 'not_pending') throw createError({ statusCode: 409, statusMessage: '此訂單已非待付款狀態' })

  // 稽核（`C-254`）：訂單狀態的變動要對得起帳——⛔ 這種事不留紀錄，對帳時只能猜
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'payment.voidOrder',
    targetId: merchantOrderNo,
    after: { orderId: merchantOrderNo, status: '已取消' },
    note: '把一筆還沒付款的訂單取消掉',
  })

  return { ok: true }
})
