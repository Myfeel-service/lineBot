import { getDb } from '~~/server/utils/firebase'
import { closeConversationSession } from '~~/server/utils/conversation-session'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const sessionId = getRouterParam(event, 'sessionId')
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: 'sessionId required' })

  const db = getDb()
  const sessionSnap = await db.collection('conversationSessions').doc(sessionId).get()
  const session = sessionSnap.data()
  if (!sessionSnap.exists || session?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此會話' })
  }

  const userId = session!.userId as string
  // 這份剛讀出來的資料直接交下去：不帶的話同一份文件會再被讀一次（多一趟往返）
  await closeConversationSession(sessionId, userId, { session })

  return { ok: true }
})
