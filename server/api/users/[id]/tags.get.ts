import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'

/**
 * GET /api/users/:id/tags
 * 取得單一用戶目前擁有的所有標籤（含標籤詳細資訊）
 *
 * Response:
 * {
 *   userId: string,
 *   tags: Array<{
 *     userTagId: string
 *     tagId: string
 *     code: string
 *     name: string
 *     category: string
 *     color: string
 *     sourceType: string
 *     createdAt: Timestamp
 *     lastHitAtMs: number | null   // 最近一次被自動判到（D-55；手動貼的沒有值）
 *     hitCount: number             // 被自動判到幾次（含略過的那些次；沒有值讀成 0）
 *   }>
 * }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const userIdParam = getRouterParam(event, 'id')
  if (!userIdParam) throw createError({ statusCode: 400, statusMessage: 'userId is required' })

  const db = getDb()
  const fsUserDocId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userIdParam, workspaceId), workspaceId)

  // Verify the user belongs to this workspace
  const userSnap = await db.collection('users').doc(fsUserDocId).get()
  if (!userSnap.exists || userSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此使用者' })
  }

  const userTagsSnap = await db.collection('userTags')
    .where('userId', '==', fsUserDocId)
    .where('workspaceId', '==', workspaceId)
    .get()

  if (userTagsSnap.empty) {
    return { userId: fsUserDocId, tags: [] }
  }

  const sortedDocs = [...userTagsSnap.docs].sort((a, b) => {
    const ta = a.data().createdAt?.toMillis?.() ?? 0
    const tb = b.data().createdAt?.toMillis?.() ?? 0
    return tb - ta
  })

  // 批次查詢標籤詳細資料
  const tagIds = [...new Set(sortedDocs.map((d) => d.data().tagId as string))]
  const tagSnaps = await Promise.all(tagIds.map((tagId) => db.collection('tags').doc(tagId).get()))
  const tagMap = new Map(tagSnaps.filter((s) => s.exists).map((s) => [s.id, s.data()]))

  const tags = sortedDocs.map((d) => {
    const utData = d.data()
    const tagData = tagMap.get(utData.tagId) ?? {}
    return {
      userTagId: d.id,
      tagId: utData.tagId,
      code: tagData.code ?? '',
      name: tagData.name ?? '',
      category: tagData.category ?? '',
      color: tagData.color ?? '',
      sourceType: utData.sourceType,
      createdAt: utData.createdAt,
      /**
       * `D-55`：最近一次「客人又表現了這個意圖」與累計次數。
       *
       * ⛔ 一定要吐出來，否則就是「寫進資料庫但沒人看得見」——這個 repo 有零使用
       * 功能的前科（見記憶 `feedback_absence_claims_need_verification`）。
       * ⛔ 沒有值就回 null／0，**不要用 `createdAt` 頂替 `lastHitAtMs`**：
       * 那兩個是不同的事實（第一次貼上 vs 最後一次被判到），頂替就是製造假資料。
       * 後台手動貼的標籤天生沒有值＝從來沒被自動判到過，`hitCount` 讀成 0 是對的。
       */
      lastHitAtMs: typeof utData.lastHitAtMs === 'number' ? utData.lastHitAtMs : null,
      hitCount: typeof utData.hitCount === 'number' ? utData.hitCount : 0,
    }
  })

  return { userId: fsUserDocId, tags }
})
