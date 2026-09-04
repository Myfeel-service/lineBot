import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { reviewSuggestions } from '~~/server/utils/tag-suggestion-review'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'

/**
 * POST /api/users/:id/tag-suggestions — AI 標籤建議的採用／忽略（D-24 收件匣）
 *
 * Body: { action: 'apply' | 'dismiss', tagIds: string[] }
 * - apply：真的貼上（sourceType='ai'，tagLogs 有紀錄、客人單頁看得出是 AI 貼的），
 *   並從 pending 移除。之後若手動把標籤拿掉，AI 是可以再建議的——拿掉≠永不適用。
 * - dismiss：從 pending 移除並記進 dismissedTagIds，**這個標籤對這位客人永不再建議**
 *   （⛔ 判過的不再重生）。
 *
 * ⛔ 實際的寫入規則在 `server/utils/tag-suggestion-review.ts`（`D-61` 抽出去的）：
 * 標籤頁的「一次審一整顆」走的是同一支，這裡只負責把結果翻成 HTTP 狀態碼。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')

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

  const { outcome, processed } = await reviewSuggestions(getDb(), {
    workspaceId, userDocId: fsUserDocId, tagIds, action, operatorId: uid,
  })
  if (outcome === 'not_found') {
    throw createError({ statusCode: 404, statusMessage: '這位客人沒有待處理的建議' })
  }
  if (outcome === 'already_handled') {
    throw createError({ statusCode: 400, statusMessage: '這些建議已經被處理過了，重新整理看看' })
  }

  return { action, processed }
})
