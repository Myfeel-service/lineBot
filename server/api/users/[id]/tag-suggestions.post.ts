import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { addTagsToUser } from '~~/server/utils/tagging'
import { AI_TAG_SUGGEST_SOURCE_REF } from '~~/server/utils/ai-tag-suggest'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import type { UserTagSuggestionDoc } from '~~/shared/types/tag-broadcast'

/**
 * POST /api/users/:id/tag-suggestions — AI 標籤建議的採用／忽略（D-24 收件匣）
 *
 * Body: { action: 'apply' | 'dismiss', tagIds: string[] }
 * - apply：真的貼上（sourceType='ai'，tagLogs 有紀錄、客人單頁看得出是 AI 貼的），
 *   並從 pending 移除。之後若手動把標籤拿掉，AI 是可以再建議的——拿掉≠永不適用。
 * - dismiss：從 pending 移除並記進 dismissedTagIds，**這個標籤對這位客人永不再建議**
 *   （⛔ 判過的不再重生）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const userIdParam = getRouterParam(event, 'id')
  if (!userIdParam) throw createError({ statusCode: 400, statusMessage: 'userId is required' })
  const fsUserDocId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userIdParam, workspaceId), workspaceId)

  const body = await readBody(event)
  const action = body?.action
  const tagIds: string[] = Array.isArray(body?.tagIds) ? body.tagIds.map((t: unknown) => String(t)) : []
  if (action !== 'apply' && action !== 'dismiss') {
    throw createError({ statusCode: 400, statusMessage: 'action must be apply or dismiss' })
  }
  if (!tagIds.length) {
    throw createError({ statusCode: 400, statusMessage: 'tagIds array is required and must not be empty' })
  }

  const db = getDb()
  const sugRef = db.collection('userTagSuggestions').doc(fsUserDocId)
  const sugSnap = await sugRef.get()
  const sugDoc = sugSnap.data() as UserTagSuggestionDoc | undefined
  if (!sugSnap.exists || sugDoc?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '這位客人沒有待處理的建議' })
  }

  const pending = Array.isArray(sugDoc.pending) ? sugDoc.pending : []
  // 只動「還在 pending 裡」的：兩個客服同時開著同一位，後按的那位不該重複貼標
  const target = tagIds.filter(id => pending.some(p => p.tagId === id))
  if (!target.length) {
    throw createError({ statusCode: 400, statusMessage: '這些建議已經被處理過了，重新整理看看' })
  }

  if (action === 'apply') {
    await addTagsToUser(fsUserDocId, target, 'ai', AI_TAG_SUGGEST_SOURCE_REF, workspaceId)
  }

  const dismissedTagIds = Array.isArray(sugDoc.dismissedTagIds) ? sugDoc.dismissedTagIds : []
  await sugRef.set({
    pending: pending.filter(p => !target.includes(p.tagId)),
    dismissedTagIds: action === 'dismiss'
      ? [...new Set([...dismissedTagIds, ...target])]
      : dismissedTagIds,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  return { action, processed: target }
})
