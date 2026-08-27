import { getDb } from '~~/server/utils/firebase'
import type { KpiResult } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { taipeiDateKey, taipeiDayEnd, taipeiDayStart } from '~~/shared/taipei-day'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { getAiSettings } from '~~/server/utils/ai-settings'
import { DEFAULT_SLA_REMIND_MINUTES } from '~~/shared/types/ai-knowledge'
import { isServiceHoursDnd } from '~~/shared/time'
import { loadDayStats, mergeDays, taipeiDayKeysBetween } from '~~/server/utils/conversation-stats-rollup'

export default defineEventHandler(async (event): Promise<KpiResult> => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const query = getQuery(event)
  const db = getDb()

  // 預設區間與 trend.get.ts 對齊（近 30 天），否則「KPI 全時段 vs 趨勢近 30 天」會出現
  // 「KPI 有數字、趨勢無資料」的矛盾。前端一律會帶 startDate/endDate，此預設為直呼 API 的保險。
  // 日界線一律取台北時間（見 taipei-day.ts；舊寫法在 UTC 伺服器上會把窗平移 8 小時）。
  const startDate = taipeiDayStart(query.startDate)
    ?? taipeiDayStart(taipeiDateKey(new Date(Date.now() - 29 * 24 * 3600_000)))!
  const endDate = taipeiDayEnd(query.endDate) ?? new Date()

  /**
   * 數字來源＝每一天的日結（沒有／過期／今天就現場算，見 conversation-stats-rollup.ts）。
   * 原本是把區間內每一場對話翻出來現場數：近 30 天 2,014 場、而這一頁要數三遍（`E-29`）。
   * ⛔ 算式沒有搬——日結與現場算共用同一支 `foldSessionIntoDay`，所以兩條路的數字必然一致。
   */
  const dayKeys = taipeiDayKeysBetween(startDate, endDate)
  const { days } = await loadDayStats(db, workspaceId, dayKeys)
  const agg = mergeDays('range', dayKeys.map(k => days.get(k)!).filter(Boolean))

  // 新朋友查不到時回 -1（前端顯示「查不到」，不裝 0）
  const newFriends = agg.newFriends ?? -1

  // 名單樣本：補客人名字，讓昨日摘要卡能點名開單場對話。每組只補 3 筆（3 次 doc 讀取）。
  // 查名字失敗回空陣列，數字照常。
  const sampleNames = (list: { userId: string }[]) => Promise.all(
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
  // ⛔ 門檻與服務時間**在這裡才套**，日結只存原料：設定改了，歷史數字要跟著改口徑
  //    （見 conversation-stats-rollup.ts 檔頭原則③）。
  const settings = await getAiSettings(workspaceId, db).catch((e) => {
    console.error('[conversation-stats] getAiSettings error:', e)
    return null
  })
  const slaMinutes = settings?.handoffNotify?.slaRemindMinutes || DEFAULT_SLA_REMIND_MINUTES
  const nowMs = Date.now()
  const slaExceeded = agg.handoffWaits
    .filter((w) => {
      const replied = w.repliedAtMs ?? nowMs
      return replied - w.requestedAtMs > slaMinutes * 60_000
    })
    // 服務時間外＝轉真人那一刻就已經下班了（複用勿擾判斷，不自己再寫一套時段邏輯）。
    // 服務時間未啟用時 isServiceHoursDnd 恆 false → offHours 全 0，UI 不會出現那個子句。
    .map(w => ({ wait: w, offHours: isServiceHoursDnd(settings?.serviceHours, new Date(w.requestedAtMs)) }))
    // 服務時間內的排前面：真正要檢討的是「上班還讓客人等」的那幾場，點名要點到它們
    .sort((a, b) =>
      Number(a.offHours) - Number(b.offHours)
      || a.wait.openedAtMs - b.wait.openedAtMs)

  const [unhandledSamples, handoffWaitSamples] = await Promise.all([
    sampleNames(agg.unhandledSamples),
    sampleNames(slaExceeded.map(x => x.wait)),
  ])

  const total = agg.total
  // ⚠️ 這裡的「未首接」是**統計**口徑（有沒有人回答過客人），與收件匣側欄的
  //    「未首接」佇列（status==='open'，還需不需要人處理）**刻意不同**，
  //    兩個數字不一樣不是 bug。改動前先讀 docs/CONVERSATION-STATS-DEFINITIONS.md。
  const handledCount = agg.bot + agg.ai + agg.human

  return {
    total,
    botHandled: agg.bot,
    aiHandled: agg.ai,
    humanHandled: agg.human,
    unhandled: agg.unhandled,
    // 首接後仍升級真人 = 該 handler 沒能獨立收尾（現成 hasHandoff 交叉，無需新埋點）。
    // 誠實訊號:不宣稱「已解決」，只呈現「首接後有多少最終還是要真人」。
    botEscalated: agg.botEscalated,
    aiEscalated: agg.aiEscalated,
    handoffCount: agg.handoff,
    handoffRate: total > 0 ? agg.handoff / total : 0,
    closedCount: agg.closed,
    handledCount,
    closeRateByTotal: total > 0 ? agg.closed / total : 0,
    // 「已處理且已結束」：分子必須是分母（已處理）的子集，否則「未首接卻被結案」的會話
    // 會讓 closeRateByHandled 超過 100%（先前 12/6 = 200% 的來源就是把 unhandled 的結案也算進分子）。
    closeRateByHandled: handledCount > 0 ? agg.closedHandled / handledCount : 0,
    newFriends,
    unhandledSamples,
    handoffWaitExceeded: slaExceeded.length,
    handoffWaitSlaMinutes: slaMinutes,
    handoffWaitOffHours: slaExceeded.filter(x => x.offHours).length,
    handoffWaitSamples,
  }
})
