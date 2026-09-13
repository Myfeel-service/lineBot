import { getDb } from '~~/server/utils/firebase'
import { closeConversationSession } from '~~/server/utils/conversation-session'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'
import {
  CONVERSATION_BATCH_LIMIT,
  type ConversationBatchFailure,
  type ConversationBatchResult,
  type ConversationBatchSkip,
} from '~~/shared/conversation-batch'

/**
 * POST /api/conversations/sessions/batch-close
 * Body: { sessionIds: string[] }
 *
 * 對話列表勾選之後「一次結束多場會話」。
 *
 * 語意與單筆的 `[sessionId]/close.post.ts` **完全一樣**（一律當成「有人按下結束」：
 * 不帶 reason，所以「這位客人歸真人」的記號會被清掉、下次來訊由 AI／機器人接手）。
 * 刻意不另立一套規則——批次只是少按幾次，不是另一種結束。
 *
 * 回傳三堆（做了／略過／失敗），原因見 ~~/shared/conversation-batch.ts。
 */

/**
 * 同時關幾場。
 *
 * 排成一條線的話 100 筆＝100 趟 Firestore 往返，客服看著轉圈好幾秒（同 09-11 把單筆
 * 結束從 3 秒降到 1 秒的那筆帳）；但也不能全部一起放出去——`closeConversationSession`
 * 每場自己要讀一次對話文件再 commit 一批寫入，一次灌 100 條連線只是把壅塞換個地方。
 */
const CLOSE_CONCURRENCY = 6

export default defineEventHandler(async (event): Promise<ConversationBatchResult> => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')

  const body = await readBody(event)
  const raw: unknown[] = Array.isArray(body?.sessionIds) ? body.sessionIds : []
  // 去重：畫面上同一列被勾兩次（重繪時的競態）不該讓同一場被關兩遍
  const sessionIds = [...new Set(raw.map(v => String(v ?? '').trim()).filter(Boolean))]

  if (!sessionIds.length) {
    throw createError({ statusCode: 400, statusMessage: 'sessionIds required' })
  }
  if (sessionIds.length > CONVERSATION_BATCH_LIMIT) {
    throw createError({
      statusCode: 400,
      statusMessage: `一次最多 ${CONVERSATION_BATCH_LIMIT} 場，請分批處理`,
    })
  }

  const db = getDb()

  /**
   * 先把這批會話一次讀回來（`getAll` 一趟），不要在迴圈裡一場讀一次。
   * 讀回來的資料等下直接交給 `closeConversationSession`（它支援帶入 session，
   * 不帶就會再讀一次＝同一份文件讀兩趟）。
   */
  const snaps = await db.getAll(
    ...sessionIds.map(id => db.collection('conversationSessions').doc(id)),
  )

  const skipped: ConversationBatchSkip[] = []
  const failed: ConversationBatchFailure[] = []
  const doneIds: string[] = []
  const todo: { sessionId: string, userId: string, session: Record<string, any> }[] = []

  for (const snap of snaps) {
    const session = snap.data() as Record<string, any> | undefined
    /**
     * ⛔ 歸屬一定要逐筆驗：sessionIds 是前端送來的，只憑登入身分就照關等於
     * 「知道 id 就能關掉別家官方帳號的對話」。
     */
    if (!snap.exists || !session || session.workspaceId !== workspaceId) {
      skipped.push({ id: snap.id, reason: 'not_found' })
      continue
    }
    if (session.status === 'closed') {
      skipped.push({ id: snap.id, reason: 'already_closed' })
      continue
    }
    const userId = String(session.userId ?? '').trim()
    if (!userId) {
      // 會話文件壞了（沒有客人 id）——不是「已結束」也不是寫入失敗，當查不到處理
      skipped.push({ id: snap.id, reason: 'not_found' })
      continue
    }
    todo.push({ sessionId: snap.id, userId, session })
  }

  // 固定數量的工人各自從佇列拿下一件，做完才拿下一件（不是切成六等份：
  // 每場的耗時差很多，切等份會變成最慢那份拖著整批）
  let cursor = 0
  const worker = async () => {
    while (cursor < todo.length) {
      const item = todo[cursor++]
      if (!item) return
      try {
        await closeConversationSession(item.sessionId, item.userId, { session: item.session })
        doneIds.push(item.sessionId)
      }
      catch (e: any) {
        // 一場炸掉不可以讓整批中斷：剩下的照做，失敗的那幾筆原樣回報給畫面
        console.error('[conversations/batch-close] 結束會話失敗:', item.sessionId, e)
        failed.push({
          id: item.sessionId,
          message: String(e?.message || e || '未知錯誤').slice(0, 200),
        })
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CLOSE_CONCURRENCY, todo.length) }, () => worker()),
  )

  /**
   * 留稽核：一次關掉幾十場屬於「三個月後會有人問是誰幹的」等級的操作。
   * 只在真的關掉東西時寫（沒動到就不留噪音，同 C-31 Phase 0 的規矩）。
   */
  if (doneIds.length) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'conversations/sessions.batchClose',
      after: { closedSessionIds: doneIds.slice(0, 100), count: doneIds.length },
      note: `批次結束會話 ${doneIds.length} 場`
        + `${skipped.length ? `，略過 ${skipped.length}` : ''}`
        + `${failed.length ? `，失敗 ${failed.length}` : ''}`,
    })
  }

  return {
    requested: sessionIds.length,
    done: doneIds.length,
    skipped,
    failed,
    doneIds,
  }
})
