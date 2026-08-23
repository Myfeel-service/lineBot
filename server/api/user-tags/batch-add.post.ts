import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import type { UserTagDoc, TagLogDoc } from '~~/shared/types/tag-broadcast'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { prunePendingForAppliedTags } from '~~/server/utils/ai-tag-suggest'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'

const FIRESTORE_BATCH_LIMIT = 400

/**
 * POST /api/user-tags/batch-add
 * 批次對多位用戶加上一或多個標籤
 *
 * Body:
 * {
 *   userIds: string[]   // LINE userIds
 *   tagIds: string[]
 * }
 *
 * Response:
 * {
 *   total: number       // 嘗試寫入筆數（userIds × tagIds）
 *   added: number       // 實際新增
 *   skipped: number     // 已存在略過
 * }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const body = await readBody(event)
  const userIds: string[] = body?.userIds ?? []
  const tagIds: string[] = body?.tagIds ?? []

  if (!userIds.length || !tagIds.length) {
    throw createError({ statusCode: 400, statusMessage: 'userIds and tagIds are required' })
  }

  if (userIds.length > 5000) {
    throw createError({ statusCode: 400, statusMessage: 'userIds must not exceed 5000 per request' })
  }

  const db = getDb()
  const now = FieldValue.serverTimestamp()
  let added = 0
  let skipped = 0

  // 分批寫入，避免超過 Firestore 單批 500 筆限制
  let batch = db.batch()
  let opsInBatch = 0

  const flushBatch = async () => {
    if (opsInBatch > 0) {
      await batch.commit()
      batch = db.batch()
      opsInBatch = 0
    }
  }

  for (const userId of userIds) {
    const fsUserDocId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userId, workspaceId), workspaceId)
    for (const tagId of tagIds) {
      const docId = `${fsUserDocId}_${tagId}`
      const ref = db.collection('userTags').doc(docId)
      const snap = await ref.get()

      if (snap.exists) {
        skipped++
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
      opsInBatch++

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
      opsInBatch++
      added++

      if (opsInBatch >= FIRESTORE_BATCH_LIMIT) {
        await flushBatch()
      }
    }
  }

  await flushBatch()

  // 同 users/[id]/tags.post：貼上去的標籤要從 AI 建議收件匣剪掉，
  // 否則列表那顆「AI 建議」章會為已經做完的決定一直亮著
  if (added > 0) {
    const fsUserDocIds = userIds.map(uid =>
      lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(uid, workspaceId), workspaceId))
    await prunePendingForAppliedTags(db, workspaceId, fsUserDocIds, tagIds)
  }

  return { total: userIds.length * tagIds.length, added, skipped }
})
