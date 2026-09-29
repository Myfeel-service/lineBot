import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'

const VALID_ROLES: WorkspaceMemberRole[] = ['admin', 'agent', 'viewer']

/**
 * PUT /api/admin/workspaces/:workspaceId/member-invites/:inviteId
 * 更新待加入邀請的角色。需 admin 以上。
 * Body: { role: 'admin' | 'agent' | 'viewer' }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'members.manage')
  const inviteId = getRouterParam(event, 'inviteId')
  if (!inviteId) throw createError({ statusCode: 400, statusMessage: 'inviteId is required' })

  const body = await readBody(event)
  const { role } = body
  if (!VALID_ROLES.includes(role)) {
    throw createError({ statusCode: 400, statusMessage: `role must be one of: ${VALID_ROLES.join(', ')}` })
  }

  const db = getDb()
  const ref = db.collection('workspaceInvites').doc(inviteId)
  const snap = await ref.get()
  // 別的帳號的邀請跟「不存在」長得一樣（回 403 等於證實這個編號存在）
  if (!snap.exists || snap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此邀請' })
  }

  await ref.update({ role })

  // 稽核（`C-254`）：邀請還沒被接受，但它決定對方一進來是什麼權限
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'memberInvite.put',
    targetId: inviteId,
    before: { email: String(snap.data()?.email ?? ''), role: String(snap.data()?.role ?? '') },
    after: { role },
  }, db)

  return { id: inviteId, role }
})
