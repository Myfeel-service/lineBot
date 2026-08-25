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
  const { workspaceId, uid, token } = await requireWorkspaceAccess(event, 'agent')

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

  /**
   * 按「我接手」的人就是負責人員（G-27 功能缺口②）。
   *
   * 自動指派是這個功能會不會被用起來的關鍵：多一步手動指派，忙起來就沒人做，
   * 清單上永遠是空的，等於白做。「我接手」本來就是在宣告「這個我來」。
   *
   * ⛔ 已經有人負責就**不覆蓋**：接手鈕在 pending_human 以外的狀態也點得到
   *    （例如同事 A 已在跟、B 手滑點了），靜靜把負責人換成 B 比沒有負責人更糟。
   * ⛔ 指派失敗不能讓接手失敗：接手（機器人閉嘴）是主要目的，
   *    負責人員只是分工標記，吞掉錯誤並留 log。
   */
  try {
    const convRef = db.collection('conversations').doc(session.userId as string)
    const conv = await convRef.get()
    if (conv.exists && !String(conv.data()?.assigneeUid ?? '').trim()) {
      await convRef.update({
        assigneeUid: uid,
        assigneeName: String(token.name || token.email || '').trim() || uid,
        assignedAt: new Date(),
      })
    }
  }
  catch (e: unknown) {
    console.warn('[takeover] 自動指派負責人員失敗（接手本身已完成）:', String((e as Error)?.message ?? e).slice(0, 200))
  }

  return { ok: true }
})
