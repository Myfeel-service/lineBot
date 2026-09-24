import { FieldValue } from 'firebase-admin/firestore'
import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { getFirebaseAuth } from '~~/server/utils/firebase'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/admin/super/users/:uid/super-admin
 * 授予 super admin 身份。冪等:對已是 super admin 者呼叫即「補登記」到清單。
 */
export default defineEventHandler(async (event) => {
  const { token } = await requireSuperAdmin(event)

  const uid = getRouterParam(event, 'uid')
  if (!uid) throw createError({ statusCode: 400, statusMessage: 'uid is required' })

  const auth = getFirebaseAuth()
  let user
  try {
    user = await auth.getUser(uid)
  } catch {
    throw createError({ statusCode: 404, statusMessage: '找不到此使用者' })
  }

  const existing = user.customClaims ?? {}
  await auth.setCustomUserClaims(uid, { ...existing, superAdmin: true })

  // 同步寫入可列舉索引:權限判斷來源仍是上面的 custom claim,此集合僅供列表/對帳。
  await getDb().collection('superAdmins').doc(uid).set({
    email: user.email ?? null,
    displayName: user.displayName ?? null,
    grantedBy: token.uid,
    grantedByEmail: token.email ?? null,
    grantedAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  /*
   * 稽核（`C-254`）：超級管理員**繞過所有權限檢查、看得到每一個客戶的每一份資料**。
   * 這是全系統權限最高的一顆按鈕，⛔ 在這之前它一筆紀錄都沒有。
   */
  await writeAuditLog({
    workspaceId: '',
    scope: 'platform',
    uid: token.uid,
    actor: 'human',
    action: 'super.superAdminGrant',
    targetId: uid,
    after: { email: user.email ?? '', superAdmin: true },
    note: `${user.email ?? uid} 現在是超級管理員，看得到所有客戶的資料`,
  })

  return { uid, superAdmin: true }
})
