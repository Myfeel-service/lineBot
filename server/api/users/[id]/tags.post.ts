import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import type { UserTagDoc, TagLogDoc } from '~~/shared/types/tag-broadcast'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { prunePendingForAppliedTags } from '~~/server/utils/ai-tag-suggest'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { filterWorkspaceTagIds } from '~~/server/utils/workspace-tag-ids'

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
 *   dropped?: string[] // 不是這個帳號的標籤（或已不存在），沒貼（G-98）
 * }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'customers.write')

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

  /**
   * G-98：只貼這個帳號自己的標籤。知道別家標籤的 id 不能貼到自家客人身上
   * （好友頁會把那顆標籤的名字、顏色讀出來）。
   * ⛔ 一顆都不剩就回 404，不回 200：回「成功、貼了 0 顆」畫面會以為貼好了。
   * ⛔ 回給前端的 dropped 只有 id、不分「別家的」還是「不存在」——分開講等於告訴對方別家有這顆。
   */
  const owned = await filterWorkspaceTagIds(db, workspaceId, tagIds, { context: 'users/[id]/tags.post' })
  if (!owned.kept.length) {
    throw createError({ statusCode: 404, statusMessage: '找不到這些標籤（可能已被刪除），請重新整理後再選' })
  }

  const now = FieldValue.serverTimestamp()
  const added: string[] = []
  const skipped: string[] = []
  const batch = db.batch()

  for (const tagId of owned.kept) {
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
      createdBy: uid,
      createdAt: now,
    }
    batch.set(ref, userTagDoc)

    // 寫入操作 log。G-107：記下是誰貼的——貼標會改變推播對象，事後要查得到人
    const logDoc: TagLogDoc = {
      workspaceId,
      action: 'add',
      userId: fsUserDocId,
      tagId,
      sourceType: 'manual',
      sourceRefId: null,
      operatorId: uid,
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

  return {
    userId: fsUserDocId,
    added,
    skipped,
    ...(owned.dropped.length ? { dropped: owned.dropped.map(d => d.tagId) } : {}),
  }
})
