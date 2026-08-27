import { getDb } from '~~/server/utils/firebase'
import type { TrendBucket, TrendGranularity } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { shiftToTaipei, taipeiDateKey, taipeiDayEnd, taipeiDayStart } from '~~/server/utils/taipei-day'
import { loadDayStats, mergeDays, taipeiDayKeysBetween } from '~~/server/utils/conversation-stats-rollup'

/** 分桶用台北日曆（shiftToTaipei 後只能讀 getUTC*）；用本機 getters 在 UTC 伺服器上會把凌晨的場分去前一天 */
function bucketKey(date: Date, granularity: TrendGranularity): string {
  const t = shiftToTaipei(date)
  const y = t.getUTCFullYear()
  const m = String(t.getUTCMonth() + 1).padStart(2, '0')
  const d = String(t.getUTCDate()).padStart(2, '0')
  if (granularity === 'day') return `${y}-${m}-${d}`
  if (granularity === 'month') return `${y}-${m}`
  // week: ISO week start (Monday)
  const day = t.getUTCDay()
  const diff = t.getUTCDate() - day + (day === 0 ? -6 : 1)
  const monday = new Date(t)
  monday.setUTCDate(diff)
  const wm = String(monday.getUTCMonth() + 1).padStart(2, '0')
  const wd = String(monday.getUTCDate()).padStart(2, '0')
  return `${monday.getUTCFullYear()}-${wm}-${wd}`
}

export default defineEventHandler(async (event): Promise<{ buckets: TrendBucket[] }> => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const query = getQuery(event)
  const granularity: TrendGranularity =
    query.granularity === 'week' || query.granularity === 'month'
      ? (query.granularity as TrendGranularity)
      : 'day'

  const db = getDb()

  // 日界線取台北時間，與 kpi.get.ts 同修（見 taipei-day.ts）
  const startDate = taipeiDayStart(query.startDate)
    ?? taipeiDayStart(taipeiDateKey(new Date(Date.now() - 29 * 24 * 3600_000)))!
  const endDate = taipeiDayEnd(query.endDate) ?? new Date()

  /**
   * 數字來源＝每一天的日結（沒有／過期／今天就現場算，見 conversation-stats-rollup.ts）。
   * 90 天的趨勢原本要把 4,337 場對話整批翻回來（`E-29`）。
   * 分桶（日／週／月）就是把那幾天加起來——算式與 KPI 共用同一支，不會各算各的。
   */
  const dayKeys = taipeiDayKeysBetween(startDate, endDate)
  const { days } = await loadDayStats(db, workspaceId, dayKeys)

  // 依 granularity 併桶
  const grouped = new Map<string, string[]>()
  for (const key of dayKeys) {
    const bk = bucketKey(taipeiDayStart(key)!, granularity)
    const list = grouped.get(bk)
    if (list) list.push(key)
    else grouped.set(bk, [key])
  }

  // 新朋友：只要有一天查不到就整批省略這個欄位——圖上缺線比畫假的 0 線誠實
  const friendsUnavailable = dayKeys.some(k => days.get(k)?.newFriends == null)

  const buckets: TrendBucket[] = []
  for (const [bk, keys] of grouped) {
    const merged = mergeDays(bk, keys.map(k => days.get(k)!).filter(Boolean))
    // 與原本的行為一致：沒有對話、也沒有新朋友的日子不生桶
    // （活動日常見的「加了一堆好友、還沒人開口」仍會生桶）
    if (!merged.total && !(merged.newFriends ?? 0)) continue
    buckets.push({
      date: bk,
      total: merged.total,
      bot: merged.bot,
      ai: merged.ai,
      human: merged.human,
      unhandled: merged.unhandled,
      handoff: merged.handoff,
      closed: merged.closed,
      aiEscalated: merged.aiEscalated,
      ...(friendsUnavailable ? {} : { newFriends: merged.newFriends ?? 0 }),
    })
  }

  buckets.sort((a, b) => a.date.localeCompare(b.date))
  return { buckets }
})
