import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import type { UserTagDoc, TagLogDoc } from '~~/shared/types/tag-broadcast'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { prunePendingForAppliedTags } from '~~/server/utils/ai-tag-suggest'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'

/**
 * POST /api/users/:id/tags
 * 對單一用戶新增一或多個標籤
 *
 * Body:
 * {
 *   tagIds: string[]
 * }
 *
 * Response:
 * {
 *   userId: string
 *   added: string[]    // 實際新增的 tagId
 *   skipped: string[]  // 已存在，略過
 * }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const userIdParam = getRouterParam(event, 'id')
  if (!userIdParam) throw createError({ statusCode: 400, statusMessage: 'userId is required' })
  const fsUserDocId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userIdParam, workspaceId), workspaceId)

  const body = await readBody(event)
  const tagIds: string[] = body?.tagIds ?? []

  if (!tagIds.length) {
    throw createError({ statusCode: 400, statusMessage: 'tagIds array is required and must not be empty' })
  }

  const db = getDb()

  // Verify the user belongs to this workspace
  const userSnap = await db.collection('users').doc(fsUserDocId).get()
  if (!userSnap.exists || userSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此使用者' })
  }

  const now = FieldValue.serverTimestamp()
  const added: string[] = []
  const skipped: string[] = []
  const batch = db.batch()

  for (const tagId of tagIds) {
    const docId = `${fsUserDocId}_${tagId}`
    const ref = db.collection('userTags').doc(docId)
    const snap = await ref.get()

    if (snap.exists) {
      skipped.push(tagId)
      continue
    }

    const userTagDoc: UserTagDoc = {
      userId: fsUserDocId,
      tagId,
      workspaceId,
      sourceType: 'manual',
      sourceRefId: null,
      createdBy: null,
      createdAt: now,
    }
    batch.set(ref, userTagDoc)

    // 寫入操作 log
    const logDoc: TagLogDoc = {
      workspaceId,
      action: 'add',
      userId: fsUserDocId,
      tagId,
      sourceType: 'manual',
      sourceRefId: null,
      operatorId: null,
      createdAt: now,
    }
    batch.set(db.collection('tagLogs').doc(uuidv4()), logDoc)

    added.push(tagId)
  }

  await batch.commit()

  // 這些標籤如果正躺在 AI 建議收件匣裡，就地剪掉——不然列表那顆「AI 建議」章
  // 會為一個已經做完的決定一直亮著（見 prunePendingForAppliedTags）
  if (added.length) {
    await prunePendingForAppliedTags(db, workspaceId, [fsUserDocId], added)
  }

  return { userId: fsUserDocId, added, skipped }
})
