import { getDb } from '~~/server/utils/firebase'
import { isPreInboundFollowSession, type KpiResult } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

export default defineEventHandler(async (event): Promise<KpiResult> => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const query = getQuery(event)
  const db = getDb()

  let ref = db.collection('conversationSessions') as FirebaseFirestore.Query
  ref = ref.where('workspaceId', '==', workspaceId)

  // 預設區間與 trend.get.ts 對齊（近 30 天），否則「KPI 全時段 vs 趨勢近 30 天」會出現
  // 「KPI 有數字、趨勢無資料」的矛盾。前端一律會帶 startDate/endDate，此預設為直呼 API 的保險。
  const startDate = query.startDate ? new Date(String(query.startDate)) : (() => {
    const d = new Date(); d.setDate(d.getDate() - 29); d.setHours(0, 0, 0, 0); return d
  })()
  const endDate = query.endDate ? (() => {
    const d = new Date(String(query.endDate)); d.setHours(23, 59, 59, 999); return d
  })() : new Date()
  ref = ref.where('openedAt', '>=', startDate).where('openedAt', '<=', endDate)

  const snap = await ref.get()
  // 活動/加好友出生、客人未開口的 session 不進統計(不算未首接也不算首接)
  const sessions = snap.docs.map(d => d.data()).filter(s => !isPreInboundFollowSession(s))

  const total = sessions.length
  const botHandled = sessions.filter(s => s.initialHandler === 'bot').length
  const aiHandled = sessions.filter(s => s.initialHandler === 'ai').length
  const humanHandled = sessions.filter(s => s.initialHandler === 'human').length
  const unhandled = sessions.filter(s => s.initialHandler === 'unhandled').length
  const handoffCount = sessions.filter(s => s.hasHandoff === true).length
  const closedCount = sessions.filter(s => s.status === 'closed').length
  const handledCount = botHandled + aiHandled + humanHandled
  // 首接後仍升級真人 = 該 handler 沒能獨立收尾（現成 hasHandoff 交叉，無需新埋點）。
  // 誠實訊號:不宣稱「已解決」，只呈現「首接後有多少最終還是要真人」。
  const botEscalated = sessions.filter(s => s.initialHandler === 'bot' && s.hasHandoff === true).length
  const aiEscalated = sessions.filter(s => s.initialHandler === 'ai' && s.hasHandoff === true).length
  // 「已處理且已結束」：分子必須是分母（已處理）的子集，否則「未首接卻被結案」的會話
  // 會讓 closeRateByHandled 超過 100%（先前 12/6 = 200% 的來源就是把 unhandled 的結案也算進分子）。
  const closedHandledCount = sessions.filter(
    s => s.status === 'closed' && s.initialHandler !== 'unhandled',
  ).length

  return {
    total,
    botHandled,
    aiHandled,
    humanHandled,
    unhandled,
    botEscalated,
    aiEscalated,
    handoffCount,
    handoffRate: total > 0 ? handoffCount / total : 0,
    closedCount,
    handledCount,
    closeRateByTotal: total > 0 ? closedCount / total : 0,
    closeRateByHandled: handledCount > 0 ? closedHandledCount / handledCount : 0,
  }
})
