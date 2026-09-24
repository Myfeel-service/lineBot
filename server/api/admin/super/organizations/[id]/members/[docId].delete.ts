import { requireSuperAdmin, invalidateOrgMemberCache } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/admin/super/organizations/:id/members/:docId
 * 移除組織管理員（以 Firestore doc ID 刪除）。
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
  await docRef.delete()
  invalidateOrgMemberCache(email, orgId)

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
  }, db)

  return { docId, email, orgId, removed: true }
})
