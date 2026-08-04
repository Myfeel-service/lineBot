import { getDb } from '~~/server/utils/firebase'
import { enterModule } from '~~/server/utils/conversation-session'
import type { ConversationStatus } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

/**
 * POST /api/conversations/sessions/:sessionId/takeover
 *
 * 客服在對話頁按「我接手」：把會話轉真人處理，機器人／AI 停止自動回覆後續訊息。
 * 「交還機器人」（handback）是這件事的反向操作。
 *
 * 為什麼直接呼叫 enterModule(live_agent) 而不自己寫欄位：
 * 那是「轉真人」的唯一口徑（status → pending_human、hasHandoff、清掉 activeInput、記事件），
 * 見 docs/CONVERSATION-STATS-DEFINITIONS.md。自己寫一份會讓同一件事在兩處長出兩種語意。
 *
 * 刻意不寫 humanFirstRepliedAt：接手不等於回覆過客人，首接時間要等真人真的送出訊息
 * （onHumanOutgoingMessage）才記，否則「多久回應客人」會被按鈕點擊時間灌水。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const sessionId = getRouterParam(event, 'sessionId')
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: 'sessionId required' })

  const db = getDb()
  const sessionSnap = await db.collection('conversationSessions').doc(sessionId).get()
  if (!sessionSnap.exists || sessionSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此會話' })
  }

  const session = sessionSnap.data()!
  const status = session.status as ConversationStatus
  if (status === 'closed') {
    throw createError({ statusCode: 400, statusMessage: '此會話已結束，無法接手' })
  }
  if (status === 'pending_human' || status === 'human_handling') {
    throw createError({ statusCode: 400, statusMessage: '此會話已經是真人處理，機器人已停止自動回覆' })
  }

  await enterModule(sessionId, session.userId as string, 'live_agent', undefined, workspaceId)

  return { ok: true }
})
