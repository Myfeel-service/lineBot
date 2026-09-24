import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { invalidateOrgMemberCache, requireActiveOrgAdmin } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/admin/org/:orgId/members — 新增組織管理員。Body: { email }
 *
 * 以 Email 認人，不需要對方已有 Firebase 帳號——他下次用這個 Google 信箱登入就會直接生效。
 * 這也是為什麼「沒有權限」的畫面要把登入信箱顯示出來：邀請他的人需要的就是那個字串。
 *
 * ⚠️ 組織管理員是**組織底下所有官方帳號的 admin**（見 workspace-auth.ts），
 *    等於把整個組織的權限交出去。這不是一個輕的動作，前端要問清楚。
 *
 * ⚠️ 目前**沒有邀請信**——加進來的人不會收到任何通知，得靠邀請者自己告訴他。
 *    寄信管道還沒建（見 docs/TODO.md）。
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.params?.orgId
  if (!orgId) throw createError({ statusCode: 400, statusMessage: 'orgId is required' })

  const { uid } = await requireActiveOrgAdmin(event, orgId)

  const db = getDb()
  // 停用檢查已由 requireActiveOrgAdmin 統一處理
  const orgSnap = await db.collection('organizations').doc(orgId).get()
  if (!orgSnap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此組織' })

  const body = await readBody(event)
  const email = String(body?.email ?? '').trim().toLowerCase()
  if (!email) throw createError({ statusCode: 400, statusMessage: '請輸入 Email' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'Email 格式不正確' })
  }

  // 先擋掉「已存在」——這一步也涵蓋 super admin 那條路用 .add() 自動 ID 建的既有文件。
  const existing = await db.collection('orgMembers')
    .where('orgId', '==', orgId)
    .where('email', '==', email)
    .limit(1)
    .get()
  if (!existing.empty) throw createError({ statusCode: 409, statusMessage: '此 Email 已是組織管理員' })

  // ⚠️ 用**決定性 doc id** + create()，而不是 .add() 自動 ID。
  // 「先查再寫」在併發下有競態：兩個請求同時加同一個 email，都通過上面的 where 檢查、
  // 都 .add() → 產生兩筆重複文件，成員列表顯示兩次，還會灌大刪除端「最後一位管理員」的計數。
  // 決定性 id 讓第二筆 create() 直接碰撞失敗（code 6），天然去重。
  // email 可能含 `/`（regex 允許）會破壞 doc id → encodeURIComponent 編掉。
  const docId = `${orgId}_${encodeURIComponent(email)}`
  try {
    await db.collection('orgMembers').doc(docId).create({
      orgId,
      email,
      role: 'admin',
      invitedBy: uid,
      createdAt: FieldValue.serverTimestamp(),
    })
  }
  catch (e) {
    if ((e as { code?: number }).code === 6) { // ALREADY_EXISTS：併發下另一個請求先寫了
      throw createError({ statusCode: 409, statusMessage: '此 Email 已是組織管理員' })
    }
    throw e
  }

  invalidateOrgMemberCache(email, orgId)

  /*
   * 稽核（`C-254`）：組織管理員是**組織底下所有官方帳號的 admin**——
   * 加一個人進來等於把整個組織的權限交出去，而且對方不會收到任何通知。
   * ⚠️ 組織層動作沒有單一 workspace，所以掛 `orgId`、在平台稽核頁才看得到。
   */
  await writeAuditLog({
    workspaceId: '',
    orgId,
    uid,
    actor: 'human',
    action: 'org.memberAdd',
    targetId: docId,
    after: { email, role: 'admin' },
    note: `${email} 現在是組織管理員，底下每一個官方帳號他都管得到`,
  }, db)

  return { docId, email, role: 'admin' }
})
