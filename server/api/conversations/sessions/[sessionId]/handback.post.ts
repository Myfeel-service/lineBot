import { getDb } from '~~/server/utils/firebase'
import { handBackSessionToBot } from '~~/server/utils/conversation-session'
import { requireCapability } from '~~/server/utils/workspace-auth'

/**
 * POST /api/conversations/sessions/:sessionId/handback
 *
 * 把待真人 / 真人處理中的會話交還機器人，bot / AI 恢復接手後續訊息。
 * 與「結束會話」不同：session 維持進行中，只是 handler 換回 bot。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'conversations.reply')

  const sessionId = getRouterParam(event, 'sessionId')
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: 'sessionId required' })

  const db = getDb()
  const sessionSnap = await db.collection('conversationSessions').doc(sessionId).get()
  if (!sessionSnap.exists || sessionSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此會話' })
  }

  const userId = sessionSnap.data()!.userId as string
  const ok = await handBackSessionToBot(sessionId, userId)
  if (!ok) {
    throw createError({ statusCode: 400, statusMessage: '此會話目前不在真人處理狀態，無法交還機器人' })
  }

  return { ok: true }
})
