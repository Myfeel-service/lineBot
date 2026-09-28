import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireActiveOrgAdmin } from '~~/server/utils/workspace-auth'
import { addSystemModulesToBatch } from '~~/server/utils/workspace-system-modules'
import { defaultFreeSubscription } from '~~/server/utils/billing'
import { writeAuditLog } from '~~/server/utils/audit-log'
import { DEFAULT_MAX_WORKSPACES_PER_ORG, type OrganizationDoc } from '~~/shared/types/organization'

/**
 * POST /api/admin/org/:orgId/workspaces
 * 組織管理員在**限額內**自行建立官方帳號。請求者自動成為新 workspace 的 owner。
 * Body: { name }
 *
 * ⚠️ 限額（maxWorkspaces）是**濫用防護**，不是產品分級：每個新 OA 都自帶免費層額度，
 *    沒有上限的話一個人就能無限建 OA 換無限免費額度。super admin 不受限（他是在幫客戶開通）。
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.params?.orgId
  if (!orgId) throw createError({ statusCode: 400, statusMessage: 'orgId is required' })

  // 停用即擋收斂在 requireActiveOrgAdmin（`G-107`⑰）：原本這裡自己再寫一份停用檢查，判斷散兩處。
  // ⚠️ 超管的行為因此變了一點：原本停用的組織連超管都開不了帳號，現在超管可以
  //    （跟 requireActiveOrgAdmin「超管就是去處理被停用組織的人」同一個口徑）
  const { uid, email, isSuperAdmin } = await requireActiveOrgAdmin(event, orgId)
  // super admin 可能沒有 orgMembers email；建立時以其 token email 記錄，無則留空
  const inviterEmail = email ?? null

  const db = getDb()

  const orgSnap = await db.collection('organizations').doc(orgId).get()
  if (!orgSnap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此組織' })
  const org = orgSnap.data() as OrganizationDoc

  // 數量上限（super admin 不受限；maxWorkspaces === null 表示特批不限）
  if (!isSuperAdmin && org.maxWorkspaces !== null) {
    const limit = org.maxWorkspaces ?? DEFAULT_MAX_WORKSPACES_PER_ORG
    const countSnap = await db.collection('workspaces').where('organizationId', '==', orgId).count().get()
    const used = countSnap.data().count
    if (used >= limit) {
      throw createError({
        statusCode: 403,
        statusMessage: `此組織的官方帳號數量已達上限（${limit} 個）。需要更多請聯繫我們。`,
      })
    }
  }

  const body = await readBody(event)
  const name = body?.name?.trim()
  if (!name) throw createError({ statusCode: 400, statusMessage: '請輸入官方帳號名稱' })

  const workspaceId = uuidv4()
  const batch = db.batch()

  batch.set(db.collection('workspaces').doc(workspaceId), {
    name,
    organizationId: orgId,
    // 新帳號預設掛免費訂閱 → 立即可見額度、可被計量（見 defaultFreeSubscription 註解）。
    subscription: defaultFreeSubscription(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  batch.set(db.collection('workspaceMembers').doc(`${uid}_${workspaceId}`), {
    uid,
    workspaceId,
    organizationId: orgId,
    role: 'owner',
    invitedBy: null,
    invitedEmail: inviterEmail,
    joinedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  })

  addSystemModulesToBatch(db, batch, workspaceId)

  await batch.commit()

  /*
   * 稽核（`C-254`）。⭐ 這一筆**直接寫進新帳號自己的紀錄**（有 workspaceId 可以掛），
   * 所以新帳號的「操作紀錄」第一列就是「這個帳號是誰、什麼時候開的」——
   * 那正是三個月後最想知道的一件事。同時掛 `orgId` 讓平台那邊也查得到。
   */
  await writeAuditLog({
    workspaceId,
    orgId,
    uid,
    actor: 'human',
    action: 'org.workspaceCreate',
    targetId: workspaceId,
    after: { name, plan: 'free' },
    note: `在組織底下開了新的官方帳號「${name}」`,
  }, db)

  return { id: workspaceId, name }
})
