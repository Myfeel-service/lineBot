import { executeBroadcastSend } from '~~/server/utils/broadcast-send'
import { broadcastScheduleAtToDate } from '~~/server/utils/broadcast-schedule'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { getDoc } from '~~/server/utils/firebase'
import { writeAuditLog } from '~~/server/utils/audit-log'
import type { BroadcastDoc } from '~~/shared/types/tag-broadcast'

/**
 * POST /api/broadcast/:id/send
 * 立即發送推播
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'broadcast.send')

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const doc = await getDoc<BroadcastDoc>('broadcasts', id)
  if (!doc || doc.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
  }

  if (doc.status === 'scheduled') {
    throw createError({
      statusCode: 409,
      statusMessage: '此推播已排程，請等候自動發送，或先取消排程',
    })
  }

  const scheduledAt = broadcastScheduleAtToDate(doc.scheduleAt)
  if (scheduledAt && scheduledAt.getTime() > Date.now()) {
    throw createError({
      statusCode: 409,
      statusMessage: '此推播已設定未來排程時間，請使用「驗證並排程」或先取消排程',
    })
  }

  try {
    const result = await executeBroadcastSend(id, { source: 'manual' })

    /*
     * 稽核（`C-254`）：這是全站最該留下紀錄的一顆按鈕——訊息已經在客人手機裡，收不回來。
     * ⛔ 寫在送出**之後**：先記再送的話，送失敗會留下一筆「送出了」的假紀錄。
     * ⚠️ 送成功但記帳沒寫完（`postSendError`）也算送出去了，所以照記，把原因寫在備註裡。
     */
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'broadcast.send',
      targetId: id,
      after: {
        name: doc.name ?? '',
        totalCount: result.totalCount,
        sentCount: result.sentCount,
        failedCount: result.failedCount,
      },
      note: `送給 ${result.sentCount} 人${result.failedCount ? `（${result.failedCount} 人沒送成功）` : ''}`
        + (result.postSendError ? `；送出後記帳未完成：${result.postSendError}` : ''),
    })

    return result
  }
  catch (e: any) {
    const msg = String(e?.message ?? e)
    if (msg.includes('not found')) throw createError({ statusCode: 404, statusMessage: msg })
    if (msg.includes('已排程')) {
      throw createError({ statusCode: 409, statusMessage: msg })
    }
    if (msg.includes('Cannot send') || msg.includes('No messages') || msg.includes('audience')) {
      throw createError({ statusCode: 400, statusMessage: msg })
    }
    throw createError({ statusCode: 500, statusMessage: msg })
  }
})
