import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/broadcast/:id/cancel
 * 取消尚未開始的草稿或排程推播
 *
 * Response: { success: true, id: string }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const db = getDb()
  const ref = db.collection('broadcasts').doc(id)
  const snap = await ref.get()

  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })

  const data = snap.data()!
  if (data.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
  }

  const { status } = data
  const cancellableStatuses = ['draft', 'scheduled']

  if (!cancellableStatuses.includes(status)) {
    throw createError({ statusCode: 409, statusMessage: `Cannot cancel broadcast with status: ${status}` })
  }

  await ref.update({ status: 'cancelled', updatedAt: FieldValue.serverTimestamp() })

  // 稽核（`C-254`）：取消一則排好的推播＝那一檔不會發出去了，要查得到是誰按的
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'broadcast.cancel',
    targetId: id,
    before: { status: String(status ?? '') },
    after: { status: 'cancelled' },
    note: String(data.name ?? ''),
  }, db)

  return { success: true, id }
})
