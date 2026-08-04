import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { removeFromHandoffNotify } from '~~/server/utils/member-line-bind'

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

  return { ok: true, removed: targetUid }
})
