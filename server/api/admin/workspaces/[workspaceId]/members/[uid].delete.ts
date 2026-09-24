import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { removeFromHandoffNotify } from '~~/server/utils/member-line-bind'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/admin/workspaces/:workspaceId/members/:uid
 * 移除成員。需 admin 以上角色。
 * owner 不可被移除（需先轉移所有權）。
 */
export default defineEventHandler(async (event) => {
  const { uid: callerUid, workspaceId } = await requireWorkspaceAccess(event, 'admin')

  const targetUid = event.context.params?.uid
  if (!targetUid) throw createError({ statusCode: 400, statusMessage: 'uid is required' })

  const db = getDb()
  const memberDocId = `${targetUid}_${workspaceId}`
  const snap = await db.collection('workspaceMembers').doc(memberDocId).get()
  if (!snap.exists) {
    throw createError({ statusCode: 404, statusMessage: 'Member not found' })
  }

  if (snap.data()?.role === 'owner') {
    throw createError({ statusCode: 403, statusMessage: 'Cannot remove owner. Transfer ownership first.' })
  }

  const lineUserId = String(snap.data()?.lineUserId ?? '').trim()

  await db.collection('workspaceMembers').doc(memberDocId).delete()

  // 人都移除了通知還一直推,名單上還會留一筆對不上任何成員的 Uxxx
  if (lineUserId) await removeFromHandoffNotify(workspaceId, lineUserId)

  // 稽核（`C-254`）：把人踢出去是權限邊界的變動，⛔ 這種事沒有紀錄是不行的
  await writeAuditLog({
    workspaceId,
    uid: callerUid,
    actor: 'human',
    action: 'members.remove',
    targetId: targetUid,
    before: {
      email: String(snap.data()?.invitedEmail ?? ''),
      role: String(snap.data()?.role ?? ''),
    },
    ...(lineUserId ? { note: '順手把他從轉真人的通知名單移掉了' } : {}),
  }, db)

  return { ok: true, removed: targetUid }
})
