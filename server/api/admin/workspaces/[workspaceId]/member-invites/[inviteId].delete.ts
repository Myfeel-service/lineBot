import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/admin/workspaces/:workspaceId/member-invites/:inviteId
 * 取消待加入的 email 邀請。需 admin 以上。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'members.manage')
  const inviteId = getRouterParam(event, 'inviteId')
  if (!inviteId) throw createError({ statusCode: 400, statusMessage: 'inviteId is required' })

  const db = getDb()
  const ref = db.collection('workspaceInvites').doc(inviteId)
  const snap = await ref.get()
  // 別的帳號的邀請跟「不存在」長得一樣（回 403 等於證實這個編號存在）
  if (!snap.exists || snap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此邀請' })
  }

  await ref.delete()

  // 稽核（`C-254`）：收回邀請＝那個人再也進不來，而他自己不會收到任何通知
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'memberInvite.delete',
    targetId: inviteId,
    before: { email: String(snap.data()?.email ?? ''), role: String(snap.data()?.role ?? '') },
  }, db)

  return { ok: true }
})
