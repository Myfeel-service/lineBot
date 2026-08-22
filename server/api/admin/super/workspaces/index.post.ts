import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { requireSuperAdmin } from '~~/server/utils/workspace-auth'
import { getFirebaseAuth } from '~~/server/utils/firebase'
import { addSystemModulesToBatch } from '~~/server/utils/workspace-system-modules'
import { defaultFreeSubscription } from '~~/server/utils/billing'
import {
  LINE_BOT_USER_ID_FIELD,
  channelConflictMessage,
  checkChannelBindingConflict,
} from '~~/server/utils/line-channel-binding'

/**
 * POST /api/admin/super/workspaces
 * 建立新 workspace 並設定 owner。
 * Body: { name, ownerEmail, channelAccessToken?, channelSecret?, defaultLiffId?, organizationId? }
 */
export default defineEventHandler(async (event) => {
  await requireSuperAdmin(event)

  const body = await readBody(event)
  const { name, ownerEmail, channelAccessToken, channelSecret, defaultLiffId, organizationId } = body

  if (!name?.trim()) throw createError({ statusCode: 400, statusMessage: 'name is required' })
  if (!ownerEmail?.trim()) throw createError({ statusCode: 400, statusMessage: 'ownerEmail is required' })
  if (!organizationId) throw createError({ statusCode: 400, statusMessage: '請選擇所屬組織' })

  const auth = getFirebaseAuth()
  let ownerUid: string
  try {
    const user = await auth.getUserByEmail(ownerEmail.trim())
    ownerUid = user.uid
  } catch {
    throw createError({ statusCode: 404, statusMessage: '找不到此 Email 的使用者' })
  }

  const workspaceId = uuidv4()
  const db = getDb()
  const batch = db.batch()

  const wsData: Record<string, unknown> = {
    name: String(name).trim(),
    organizationId: organizationId ?? null,
    // 新帳號預設掛免費訂閱 → 立即可見額度、可被計量；super admin 之後可改指派付費方案。
    subscription: defaultFreeSubscription(),
    updatedAt: FieldValue.serverTimestamp(),
  }
  if (channelAccessToken) {
    // 與設定頁同一道把關：一個 LINE 官方帳號只能接在一個工作區。超管建帳號時貼到
    // 別人已經在用的憑證，後果一樣是「客人訊息整批進到另一邊、兩邊都看不出來」。
    const { identity, conflicts } = await checkChannelBindingConflict(db, workspaceId, String(channelAccessToken))
    if (conflicts.length) {
      throw createError({
        statusCode: 409,
        statusMessage: channelConflictMessage(conflicts),
        data: { reason: 'lineChannelAlreadyBound', conflicts },
      })
    }
    wsData.channelAccessToken = channelAccessToken
    if (identity.kind === 'ok') wsData[LINE_BOT_USER_ID_FIELD] = identity.botUserId
  }
  if (channelSecret) wsData.channelSecret = channelSecret
  if (defaultLiffId) wsData.defaultLiffId = defaultLiffId

  batch.set(db.collection('workspaces').doc(workspaceId), wsData)

  batch.set(db.collection('workspaceMembers').doc(`${ownerUid}_${workspaceId}`), {
    uid: ownerUid,
    workspaceId,
    organizationId: organizationId ?? null,
    role: 'owner',
    invitedBy: null,
    invitedEmail: ownerEmail.trim(),
    joinedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  })

  addSystemModulesToBatch(db, batch, workspaceId)

  await batch.commit()

  return { id: workspaceId, name: String(name).trim(), ownerUid, ownerEmail: ownerEmail.trim() }
})
