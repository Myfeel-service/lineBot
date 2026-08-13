import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

/**
 * POST /api/broadcast/:id/retry
 * 把發送失敗的推播重設回草稿，讓它能走既有的「驗證並發送／排程」流程再發一次。
 *
 * 只收 failed：completed 重發會重複轟炸；卡在 processing 的單先交給看門狗
 * （run-due-scheduled-broadcasts 的 reap，10 分鐘）收殮成 failed 再進來。
 * 這個端點本身不發任何訊息——重設之後要不要發、何時發，由使用者在後台再走一次送出流程。
 *
 * Response: { success: true, id: string }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const db = getDb()
  const ref = db.collection('broadcasts').doc(id)

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })

    const data = snap.data()!
    if (data.workspaceId !== workspaceId) {
      throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
    }
    if (data.status !== 'failed') {
      throw createError({ statusCode: 409, statusMessage: `Cannot retry broadcast with status: ${data.status}` })
    }

    tx.update(ref, {
      status: 'draft',
      scheduleAt: null,
      startedAt: null,
      completedAt: null,
      totalCount: 0,
      sentCount: 0,
      failedCount: 0,
      postSendError: null,
      failureReason: null,
      lineAggregationUnit: null,
      lineInsightAggregationApplied: null,
      'audienceSnapshot.resolvedUserIds': [],
      updatedAt: FieldValue.serverTimestamp(),
    })
  })

  // 清掉上一輪嘗試留下的失敗名單，否則重發後的成效報表會混到舊帳。
  // 看門狗收殮的卡死單這裡是 0 筆；真的全員退回的單才會有量，分批刪。
  const deliveries = ref.collection('deliveries')
  for (;;) {
    const page = await deliveries.limit(400).get()
    if (page.empty) break
    const batch = db.batch()
    for (const doc of page.docs) batch.delete(doc.ref)
    await batch.commit()
    if (page.size < 400) break
  }

  return { success: true, id }
})
