import { requireSuperAdmin, invalidateOrgMemberCache } from '~~/server/utils/workspace-auth'
import { removeOrgMemberFromWorkspaces } from '~~/server/utils/org-member-cascade'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/admin/super/organizations/:id/members/:docId
 * 移除組織管理員（以 Firestore doc ID 刪除）。
 *
 * ⭐ 一併移出組織底下每一個官方帳號（`G-96` 2026-09-29 拍板，跟組織自己那支同一套，見 org-member-cascade.ts）。
 * ⛔ 有任何一個帳號沒移成（通知名單拿不掉）就不刪組織那一筆：一刪這個人就從名單消失，連重試都找不到他。
 */
export default defineEventHandler(async (event) => {
  const { uid } = await requireSuperAdmin(event)

  const orgId = getRouterParam(event, 'id')
  const docId = getRouterParam(event, 'docId')
  if (!orgId || !docId) throw createError({ statusCode: 400, statusMessage: 'id and docId are required' })

  const db = getDb()
  const docRef = db.collection('orgMembers').doc(docId)
  const snap = await docRef.get()

  if (!snap.exists || snap.data()?.orgId !== orgId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此成員' })
  }

  const email = snap.data()!.email as string

  const cascade = await removeOrgMemberFromWorkspaces({
    db, orgId, email, actorUid: uid, note: `平台把 ${String(email).trim().toLowerCase()} 移出組織，一併從這個帳號移除`,
  })
  if (cascade.failedWorkspaceIds.length) {
    throw createError({
      statusCode: 500,
      statusMessage: `有 ${cascade.failedWorkspaceIds.length} 個官方帳號的 LINE 通知名單改不進去，他還沒被移除，請再按一次`,
    })
  }

  await docRef.delete()
  invalidateOrgMemberCache(String(email).trim().toLowerCase(), orgId)

  /*
   * 稽核（`C-254`）。⚠️ 這條路**沒有**組織自己那支的三道護欄（不能刪最後一位、
   * 不能刪擁有者、不能刪自己）——超管刪得掉最後一位管理員，組織就沒有人管得到了。
   * 這正是最需要事後查得到的那種操作。
   */
  await writeAuditLog({
    workspaceId: '',
    orgId,
    scope: 'platform',
    uid,
    actor: 'human',
    action: 'super.orgMemberRemove',
    targetId: docId,
    before: { email, role: 'admin' },
    note: `一併從 ${cascade.removed.length} 個官方帳號移除${cascade.invitesDeleted ? `，收回 ${cascade.invitesDeleted} 張還沒接受的邀請` : ''}`,
  }, db)

  return { docId, email, orgId, removed: true, removedFromWorkspaces: cascade.removed.length, invitesDeleted: cascade.invitesDeleted }
})
