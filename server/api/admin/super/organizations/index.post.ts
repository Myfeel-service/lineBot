import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { requireSuperAdmin, invalidateOrgMemberCache } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/admin/super/organizations
 * 建立新組織。Body: { name, ownerEmail }
 * ownerEmail 不需要已有 Firebase 帳號，自動加入 orgMembers（email-based）。
 */
export default defineEventHandler(async (event) => {
  const { uid: callerUid } = await requireSuperAdmin(event)

  const body = await readBody(event)
  const { name, ownerEmail } = body

  if (!name?.trim()) throw createError({ statusCode: 400, statusMessage: 'name is required' })
  if (!ownerEmail?.trim()) throw createError({ statusCode: 400, statusMessage: 'ownerEmail is required' })

  const email = String(ownerEmail).trim().toLowerCase()
  const orgId = uuidv4()
  const db = getDb()

  await db.collection('organizations').doc(orgId).set({
    name: String(name).trim(),
    ownerEmail: email,
    disabled: false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  // 自動把 ownerEmail 加入 orgMembers（admin 權限，email-based）
  await db.collection('orgMembers').add({
    orgId,
    email,
    role: 'admin',
    invitedBy: callerUid,
    createdAt: FieldValue.serverTimestamp(),
  })

  invalidateOrgMemberCache(email, orgId)

  // 稽核（`C-254`）：一個客戶的起點就是這一筆
  await writeAuditLog({
    workspaceId: '',
    orgId,
    scope: 'platform',
    uid: callerUid,
    actor: 'human',
    action: 'super.orgCreate',
    targetId: orgId,
    after: { name: String(name).trim(), email },
  }, db)

  return { id: orgId, name: String(name).trim(), ownerEmail: email }
})
