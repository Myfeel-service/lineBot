import { getDb } from '~~/server/utils/firebase'
import { isPreInboundFollowSession, type KpiResult } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { taipeiDateKey, taipeiDayEnd, taipeiDayStart } from '~~/server/utils/taipei-day'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { DEFAULT_SLA_REMIND_MINUTES } from '~~/shared/types/ai-knowledge'
import { isServiceHoursDnd } from '~~/shared/time'

export default defineEventHandler(async (event): Promise<KpiResult> => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const query = getQuery(event)
  const db = getDb()

  let ref = db.collection('conversationSessions') as FirebaseFirestore.Query
  ref = ref.where('workspaceId', '==', workspaceId)

  // 預設區間與 trend.get.ts 對齊（近 30 天），否則「KPI 全時段 vs 趨勢近 30 天」會出現
  // 「KPI 有數字、趨勢無資料」的矛盾。前端一律會帶 startDate/endDate，此預設為直呼 API 的保險。
  // 日界線一律取台北時間（見 taipei-day.ts；舊寫法在 UTC 伺服器上會把窗平移 8 小時）。
  const startDate = taipeiDayStart(query.startDate)
    ?? taipeiDayStart(taipeiDateKey(new Date(Date.now() - 29 * 24 * 3600_000)))!
  const endDate = taipeiDayEnd(query.endDate) ?? new Date()
  ref = ref.where('openedAt', '>=', startDate).where('openedAt', '<=', endDate)

  // 新朋友（第一次加好友）：與對話數平行查。count() 只回數字不拉文件。
  // ⚠️ 索引方向要 users(workspaceId ASC, createdAt **ASC**)：這支沒有 orderBy，範圍條件
  //    隱含的排序是 ASC，原本檔案裡只有 createdAt DESC 的那個服務不了它——兩個租戶都
  //    FAILED_PRECONDITION，這個數字從來沒真的查出來過（靜靜地一路回 -1）。
  // 查失敗回 -1（前端顯示「查不到」，不裝 0）。
  const newFriendsPromise = db.collection('users')
    .where('workspaceId', '==', workspaceId)
    .where('createdAt', '>=', startDate)
    .where('createdAt', '<=', endDate)
    .count().get()
    .then(s => s.data().count)
    .catch((e) => {
      console.error('[conversation-stats] newFriends count error:', e)
      return -1
    })

  const [snap, newFriends] = await Promise.all([ref.get(), newFriendsPromise])
  // 活動/加好友出生、客人未開口的 session 不進統計(不算未首接也不算首接)
  const sessions = snap.docs.map(d => d.data()).filter(s => !isPreInboundFollowSession(s))

  // 名單樣本共用：取前 3 場、補客人名字，讓昨日摘要卡能點名開單場對話。
  // 排序由呼叫端決定（不同清單的「該先看哪幾場」不一樣），這裡只負責取前 3 筆與補名字。
  // 每組只補 3 筆名字（3 次 doc 讀取），統計頁的大區間也不會放大成本。查名字失敗回空陣列，數字照常。
  const sampleNames = (list: FirebaseFirestore.DocumentData[]) => Promise.all(
    list
      .slice(0, 3)
      .map(async (s) => {
        const uid = String(s.userId || '')
        const userSnap = await db.collection('users').doc(lineUserFirestoreDocId(uid, workspaceId)).get()
          .catch(() => null)
        const displayName = String(userSnap?.data()?.displayName || '').trim() || 'LINE 用戶'
        return { userId: uid, displayName }
      }),
  ).catch((e) => {
    console.error('[conversation-stats] sampleNames error:', e)
    return [] as { userId: string; displayName: string }[]
  })

  // 轉真人後等超過 SLA：等待 = humanFirstRepliedAt − handoffRequestedAt，一直沒人接的也算
  // （客人確實等超過了）。門檻沿用工作區 slaRemindMinutes——與 SLA 提醒同一把尺，
  // 設 0（關閉提醒）時退回預設 30：提醒可以不吵，日報照樣要誠實。
  const settings = await getAiSettings(workspaceId, db).catch((e) => {
    console.error('[conversation-stats] getAiSettings error:', e)
    return null
  })
  const slaMinutes = settings?.handoffNotify?.slaRemindMinutes || DEFAULT_SLA_REMIND_MINUTES
  const nowMs = Date.now()
  const slaExceeded = sessions
    .filter((s) => {
      const requested = s.handoffRequestedAt?.toMillis?.()
      if (s.hasHandoff !== true || !requested) return false
      const replied = s.humanFirstRepliedAt?.toMillis?.() ?? nowMs
      return replied - requested > slaMinutes * 60_000
    })
    // 服務時間外＝轉真人那一刻就已經下班了（複用勿擾判斷，不自己再寫一套時段邏輯）。
    // 服務時間未啟用時 isServiceHoursDnd 恆 false → offHours 全 0，UI 不會出現那個子句。
    .map(s => ({
      session: s,
      offHours: isServiceHoursDnd(settings?.serviceHours, new Date(s.handoffRequestedAt.toMillis())),
    }))
    // 服務時間內的排前面：真正要檢討的是「上班還讓客人等」的那幾場，點名要點到它們
    .sort((a, b) =>
      Number(a.offHours) - Number(b.offHours)
      || (a.session.openedAt?.toMillis?.() ?? 0) - (b.session.openedAt?.toMillis?.() ?? 0))

  const [unhandledSamples, handoffWaitSamples] = await Promise.all([
    sampleNames(
      sessions
        .filter(s => s.initialHandler === 'unhandled')
        .sort((a, b) => (a.openedAt?.toMillis?.() ?? 0) - (b.openedAt?.toMillis?.() ?? 0)),
    ),
    sampleNames(slaExceeded.map(x => x.session)),
  ])

  const total = sessions.length
  // ⚠️ 這裡的「未首接」是**統計**口徑（有沒有人回答過客人），與收件匣側欄的
  //    「未首接」佇列（status==='open'，還需不需要人處理）**刻意不同**，
  //    兩個數字不一樣不是 bug。改動前先讀 docs/CONVERSATION-STATS-DEFINITIONS.md。
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
    newFriends,
    unhandledSamples,
    handoffWaitExceeded: slaExceeded.length,
    handoffWaitSlaMinutes: slaMinutes,
    handoffWaitOffHours: slaExceeded.filter(x => x.offHours).length,
    handoffWaitSamples,
  }
})
