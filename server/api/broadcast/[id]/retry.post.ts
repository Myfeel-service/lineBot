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
 * ⛔動作順序刻意是「先清舊帳、最後才改狀態」：清理是好幾趟批次刪除，中途掛掉（逾時、
 * 連線抖動）在所難免。狀態要是先翻成 draft，這支就再也進不來（只收 failed），舊的失敗名單
 * 與點擊紀錄就永遠混在下一次的成效報表裡；反過來排的話，任何一步失敗都只要再按一次按鈕
 * 就能從頭做完（每一步都可重複執行）。
 *
 * Response: { success: true, id: string }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const db = getDb()
  const ref = db.collection('broadcasts').doc(id)

  // ── ① 先確認身分與狀態，才動任何資料 ────────────────────────────────
  const snap = await ref.get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
  const existing = snap.data()!
  if (existing.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
  }
  if (existing.status !== 'failed') {
    throw createError({
      statusCode: 409,
      statusMessage: '這則推播現在的狀態不是「失敗」，不需要重設。請重新整理頁面再看一次。',
    })
  }

  // ── ② 清掉上一輪嘗試留下的舊帳 ───────────────────────────────────────
  // 沒收到的人（deliveries）與追蹤連結點擊（broadcastClickLogs）都以 campaignId 記帳，
  // 不清就會跟重發後的數字疊在一起（點擊率可能超過 100%）。
  // 看門狗收殮的卡死單這裡通常是 0 筆；全員退回的單才會有量，分批刪。
  const BATCH = 400
  const purgeQueries = [
    ref.collection('deliveries'),
    db.collection('broadcastClickLogs').where('campaignId', '==', id),
  ]
  for (const query of purgeQueries) {
    for (;;) {
      const page = await query.limit(BATCH).get()
      if (page.empty) break
      const batch = db.batch()
      for (const doc of page.docs) batch.delete(doc.ref)
      await batch.commit()
      if (page.size < BATCH) break
    }
  }

  // ── ③ 最後才翻回草稿（交易內重驗狀態，防兩個人同時按）────────────────
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(ref)
    if (!fresh.exists) throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
    const data = fresh.data()!
    if (data.workspaceId !== workspaceId) {
      throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
    }
    if (data.status !== 'failed') {
      throw createError({
        statusCode: 409,
        statusMessage: '這則推播現在的狀態不是「失敗」，不需要重設。請重新整理頁面再看一次。',
      })
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
      // 估算人數也要跟著歸零：那個數字來自沒送成功的那一次，留著會讓草稿在列表上
      // 顯示「206 人」，看起來像已經算好了受眾（真正的人數要等下一次送出才會重算）
      'audienceSnapshot.estimatedCount': 0,
      // 下一次發送要換一個 LINE 彙總單位，開封／點擊才不會跟上一次疊在一起
      retryCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    })
  })

  return { success: true, id }
})
