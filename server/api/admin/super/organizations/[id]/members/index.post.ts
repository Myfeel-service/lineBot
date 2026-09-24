import { FieldValue } from 'firebase-admin/firestore'
import { requireSuperAdmin, invalidateOrgMemberCache } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/admin/super/organizations/:id/members
 * 新增組織管理員（email-based，不需要對方已有 Firebase 帳號）。
 * Body: { email }
 */
export default defineEventHandler(async (event) => {
  const { uid: callerUid } = await requireSuperAdmin(event)

  const orgId = getRouterParam(event, 'id')
  if (!orgId) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const db = getDb()
  const orgSnap = await db.collection('organizations').doc(orgId).get()
  if (!orgSnap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此組織' })

  const body = await readBody(event)
  const email = String(body.email ?? '').trim().toLowerCase()
  if (!email) throw createError({ statusCode: 400, statusMessage: 'email is required' })

  // 確認此 email 尚未在此 org
  const existing = await db.collection('orgMembers')
    .where('orgId', '==', orgId)
    .where('email', '==', email)
    .limit(1)
    .get()
  if (!existing.empty) throw createError({ statusCode: 409, statusMessage: '此 Email 已是組織管理員' })

  const ref = await db.collection('orgMembers').add({
    orgId,
    email,
    role: 'admin',
    invitedBy: callerUid,
    createdAt: FieldValue.serverTimestamp(),
  })

  invalidateOrgMemberCache(email, orgId)

  // 稽核（`C-254`）：平台幫客戶加了一位組織管理員＝那個人管得到底下每一個官方帳號
  await writeAuditLog({
    workspaceId: '',
    orgId,
    scope: 'platform',
    uid: callerUid,
    actor: 'human',
    action: 'super.orgMemberAdd',
    targetId: ref.id,
    after: { email, role: 'admin' },
  }, db)

  return { id: ref.id, email, role: 'admin' }
})
