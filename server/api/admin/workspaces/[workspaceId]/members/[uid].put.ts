import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'
import type { WorkspaceMemberRole } from '~~/shared/types/organization'

const VALID_ROLES: WorkspaceMemberRole[] = ['admin', 'agent', 'viewer']

/**
 * PUT /api/admin/workspaces/:workspaceId/members/:uid
 * 更改成員角色。需 admin 以上角色。
 * 不可變更 owner 的角色（owner 只能透過轉移所有權流程處理）。
 *
 * Body: { role: 'admin' | 'agent' | 'viewer' }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'admin')

  const targetUid = event.context.params?.uid
  if (!targetUid) throw createError({ statusCode: 400, statusMessage: 'uid is required' })

  const body = await readBody(event)
  const { role } = body

  if (!VALID_ROLES.includes(role)) {
    throw createError({ statusCode: 400, statusMessage: `role must be one of: ${VALID_ROLES.join(', ')}` })
  }

  const db = getDb()
  const memberDocId = `${targetUid}_${workspaceId}`
  const snap = await db.collection('workspaceMembers').doc(memberDocId).get()
  if (!snap.exists) {
    throw createError({ statusCode: 404, statusMessage: 'Member not found' })
  }

  if (snap.data()?.role === 'owner') {
    throw createError({ statusCode: 403, statusMessage: "Cannot change owner's role. Use ownership transfer instead." })
  }

  const before = String(snap.data()?.role ?? '')
  await db.collection('workspaceMembers').doc(memberDocId).update({ role })

  // 誰把誰改成什麼權限，是出事時第一個要查的東西
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'members/role.put',
    targetId: targetUid,
    before: { role: before },
    after: { role },
  })

  return { id: memberDocId, uid: targetUid, workspaceId, role }
})
