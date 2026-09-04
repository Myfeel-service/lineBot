import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { reviewSuggestions } from '~~/server/utils/tag-suggestion-review'
import { PENDING_BULK_LIMIT } from '~~/shared/tag-pending-review'

/** 同時處理幾位（Firestore 是不同文件，衝突風險為零；控併發只是不想一次開 100 條連線） */
const CONCURRENCY = 8

/**
 * POST /api/tag/:id/pending — 一次採用／忽略**這顆標籤**的多位客人建議（`D-61`）
 *
 * Body: { action: 'apply' | 'dismiss', userIds: string[] }
 * Response: { processed, alreadyHandled, notProcessed, failed }
 *
 * ⛔ **四個數字都要回**：勾了 34 位、成功 30 位時，人要分得出另外 4 位是「別人先按掉了」
 * 還是「出錯了」——兩者的下一步完全不同（同 `feedback_filters_must_report_what_they_dropped`）。
 *
 * ⚠️ 忽略是**永久**的：那顆標籤對那位客人 AI 永不再提（連「判到直接貼」也不會貼，
 * 因為 `dismissedTagIds` 在候選階段就被排除）。畫面上一定要講，別讓人以為只是清掉待辦。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')
  const tagId = getRouterParam(event, 'id')
  if (!tagId) throw createError({ statusCode: 400, statusMessage: 'tagId is required' })

  const body = await readBody(event)
  const action = body?.action
  if (action !== 'apply' && action !== 'dismiss') {
    throw createError({ statusCode: 400, statusMessage: 'action must be apply or dismiss' })
  }
  const userIds: string[] = Array.isArray(body?.userIds)
    ? [...new Set<string>(body.userIds.map((u: unknown) => String(u)).filter((u: string) => !!u))]
    : []
  if (!userIds.length) {
    throw createError({ statusCode: 400, statusMessage: 'userIds array is required and must not be empty' })
  }

  const db = getDb()
  const tagSnap = await db.collection('tags').doc(tagId).get()
  if (!tagSnap.exists || tagSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到這顆標籤' })
  }

  // ⛔ 撞上限的那幾位要回報，不可以靜靜丟掉（呼叫端會拿 notProcessed 叫人再按一次）
  const batch = userIds.slice(0, PENDING_BULK_LIMIT)
  const notProcessed = userIds.length - batch.length

  let processed = 0
  let alreadyHandled = 0
  let failed = 0

  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const slice = batch.slice(i, i + CONCURRENCY)
    const results = await Promise.all(slice.map(async (userDocId) => {
      try {
        // 一位客人一次只處理這一顆：別順手把他其他顆待審一起做掉（人只勾了這一顆）
        return await reviewSuggestions(db, { workspaceId, userDocId, tagIds: [tagId], action, operatorId: uid })
      }
      catch (e) {
        console.warn('[tag-pending] 單位失敗:', userDocId, e)
        return null
      }
    }))
    for (const r of results) {
      if (!r) { failed += 1; continue }
      // 文件不見了跟「已經被處理過」對操作者來說是同一件事：這位不用再管
      if (r.outcome === 'done') processed += 1
      else alreadyHandled += 1
    }
  }

  return { processed, alreadyHandled, notProcessed, failed }
})
