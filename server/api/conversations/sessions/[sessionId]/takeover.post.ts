import { getDb } from '~~/server/utils/firebase'
import { enterModule, markHumanOwnership } from '~~/server/utils/conversation-session'
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
  /**
   * 按「我接手」＝真人宣告「這位客人我在處理」，記號蓋在對話上（不是只蓋在這一場）。
   * 少了這一步，客服接手後如果還沒開口、這場又被排程收掉，客人下一句就回到 AI 手上。
   * 記號只有真人按「結束會話」／「交還機器人」時才清（見 conversation-session.ts）。
   *
   * ⛔ 刻意寫在這支端點、不寫進 enterModule('live_agent')：那個是所有轉真人的共同口徑，
   * 包含 AI 判斷要轉、腳本轉、圖文選單轉——那些是「系統決定要找人」，不是真人本人動作，
   * 全部蓋記號會讓「客人打過一次找真人」的帳號從此永遠收不到自動回覆。
   */
  await markHumanOwnership(session.userId as string, workspaceId)

  return { ok: true }
})
