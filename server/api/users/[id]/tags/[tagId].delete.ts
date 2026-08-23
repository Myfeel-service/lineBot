import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import type { TagLogDoc } from '~~/shared/types/tag-broadcast'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { recordManualRemovalAsDismissed } from '~~/server/utils/ai-tag-suggest'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'

/**
 * DELETE /api/users/:id/tags/:tagId
 * 移除單一用戶的某個標籤
 *
 * Response: { success: true, userId: string, tagId: string }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const userIdParam = getRouterParam(event, 'id')
  const tagId = getRouterParam(event, 'tagId')

  if (!userIdParam || !tagId) {
    throw createError({ statusCode: 400, statusMessage: 'userId and tagId are required' })
  }

  const db = getDb()
  const fsUserDocId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userIdParam, workspaceId), workspaceId)

  // Verify the user belongs to this workspace
  const userSnap = await db.collection('users').doc(fsUserDocId).get()
  if (!userSnap.exists || userSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此使用者' })
  }

  const docId = `${fsUserDocId}_${tagId}`
  const ref = db.collection('userTags').doc(docId)
  const snap = await ref.get()

  if (!snap.exists) {
    throw createError({ statusCode: 404, statusMessage: 'User does not have this tag' })
  }

  const batch = db.batch()
  batch.delete(ref)

  const logDoc: TagLogDoc = {
    workspaceId,
    action: 'remove',
    userId: fsUserDocId,
    tagId,
    sourceType: 'manual',
    sourceRefId: null,
    operatorId: null,
    createdAt: FieldValue.serverTimestamp(),
  }
  batch.set(db.collection('tagLogs').doc(uuidv4()), logDoc)

  await batch.commit()

  // 手動拆掉的標籤＝否決票：AI 有在判的標籤記進「永不再提」，否則 auto 模式會貼回來
  // 變成人跟排程的拉鋸戰（見 recordManualRemovalAsDismissed）
  await recordManualRemovalAsDismissed(db, workspaceId, [fsUserDocId], [tagId])

  return { success: true, userId: fsUserDocId, tagId }
})
