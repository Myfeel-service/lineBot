import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { getFirebaseAuth } from '~~/server/utils/firebase'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/admin/super/users/:uid/super-admin
 * 撤銷 super admin 身份。
 */
export default defineEventHandler(async (event) => {
  const { uid: callerUid } = await requireSuperAdmin(event)

  const uid = getRouterParam(event, 'uid')
  if (!uid) throw createError({ statusCode: 400, statusMessage: 'uid is required' })
  if (uid === callerUid) throw createError({ statusCode: 400, statusMessage: '不能撤銷自己的 super admin 身份' })

  const auth = getFirebaseAuth()
  let user
  try {
    user = await auth.getUser(uid)
  } catch {
    throw createError({ statusCode: 404, statusMessage: '找不到此使用者' })
  }

  // 不可撤銷最後一位 Super Admin:至少保留一個可登入的帳號。
  const total = (await getDb().collection('superAdmins').get()).size
  if (total <= 1) {
    throw createError({ statusCode: 400, statusMessage: '至少需保留一位 Super Admin,無法撤銷最後一位' })
  }

  const existing = user.customClaims ?? {}
  const { superAdmin: _, ...rest } = existing as any
  await auth.setCustomUserClaims(uid, rest)

  // 同步移除可列舉索引(不存在則為 no-op)。
  await getDb().collection('superAdmins').doc(uid).delete()

  // 稽核（`C-254`）：跟授予同等重要——「我的權限怎麼不見了」只有這一筆答得出來
  await writeAuditLog({
    workspaceId: '',
    scope: 'platform',
    uid: callerUid,
    actor: 'human',
    action: 'super.superAdminRevoke',
    targetId: uid,
    before: { email: user.email ?? '', superAdmin: true },
    after: { superAdmin: false },
  })

  return { uid, superAdmin: false }
})
