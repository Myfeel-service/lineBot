import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireAuth, invalidateOrgMemberCache } from '~~/server/utils/workspace-auth'
import { addSystemModulesToBatch } from '~~/server/utils/workspace-system-modules'
import { defaultFreeSubscription } from '~~/server/utils/billing'

/**
 * POST /api/onboarding/self-serve
 *
 * 自助開通：登入者（此刻還沒有任何權限）一次建立「組織 + 第一個官方帳號 + 免費訂閱」，
 * 自己成為組織管理員與該帳號的 owner。這是導購漏斗把訪客變成使用者的關鍵一步——
 * 「先免費把車開回家」，付費額度之後在站內賣。
 *
 * Body: { workspaceName: string, orgName?: string }
 * Response: { workspaceId, organizationId }
 *
 * ⚠️ 防濫用：**每個 uid 只能自助建立一個組織**。組織內要再開帳號走 org 的 3-OA 上限
 *    （見 org/[orgId]/workspaces）。每個新帳號自帶免費層額度，不設限的話一個人
 *    就能無限開組織換無限免費額度。
 */

const NAME_MAX = 40

export default defineEventHandler(async (event) => {
  const { uid, email } = await requireAuth(event)
  if (!email) {
    throw createError({ statusCode: 400, statusMessage: '你的登入帳號沒有 Email，無法自助開通，請聯繫我們。' })
  }

  const body = await readBody(event).catch(() => ({})) as Record<string, unknown>
  const workspaceName = String(body?.workspaceName ?? '').trim().slice(0, NAME_MAX)
  if (!workspaceName) {
    throw createError({ statusCode: 400, statusMessage: '請輸入官方帳號名稱' })
  }
  const orgName = String(body?.orgName ?? '').trim().slice(0, NAME_MAX) || workspaceName

  const db = getDb()

  // 防濫用：每個 uid 只能自助建立一個組織。
  // 用單欄位 equality 查（ownerId），在記憶體判 createdVia，免複合索引。
  // 註：這裡到 commit 之間有極小的 TOCTOU 窗（使用者連點兩次），前端已在送出時 disable 按鈕，
  //     真的雙寫最多產生一個多餘組織，不造成安全問題；量大再改交易保護。
  const owned = await db.collection('organizations').where('ownerId', '==', uid).get()
  const alreadySelfServed = owned.docs.some(d => d.data()?.createdVia === 'self_serve')
  if (alreadySelfServed) {
    throw createError({
      statusCode: 409,
      statusMessage: '你已經建立過帳號了，回到帳號選擇即可進入。',
    })
  }

  const orgId = uuidv4()
  const workspaceId = uuidv4()
  const batch = db.batch()

  // 組織（自己是登記擁有者；createdVia 供防濫用查詢）
  batch.set(db.collection('organizations').doc(orgId), {
    name: orgName,
    ownerEmail: email,
    ownerId: uid,
    createdVia: 'self_serve',
    disabled: false,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  // 組織成員：orgMembers 是 **email-based**（getOrgMember 用 email 查）——
  // 必須用 email 寫，owner 才會被 requireOrgAdmin / requireWorkspaceAccess 認成組織管理員。
  batch.set(db.collection('orgMembers').doc(), {
    orgId,
    email,
    role: 'admin',
    invitedBy: uid,
    createdAt: FieldValue.serverTimestamp(),
  })

  // 第一個官方帳號 + 免費訂閱（立即可見額度、可被計量）
  batch.set(db.collection('workspaces').doc(workspaceId), {
    name: workspaceName,
    organizationId: orgId,
    subscription: defaultFreeSubscription(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  // 建立者成為該帳號 owner（workspaceMembers 是 uid-based）
  batch.set(db.collection('workspaceMembers').doc(`${uid}_${workspaceId}`), {
    uid,
    workspaceId,
    organizationId: orgId,
    role: 'owner',
    invitedBy: null,
    invitedEmail: email,
    joinedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  })

  addSystemModulesToBatch(db, batch, workspaceId)

  await batch.commit()

  // 讓本實例的權限快取立刻認得新 org admin（其他 serverless 實例等 TTL 過期）
  invalidateOrgMemberCache(email, orgId)

  return { workspaceId, organizationId: orgId }
})
