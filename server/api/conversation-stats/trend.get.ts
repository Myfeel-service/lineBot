import { getDb } from '~~/server/utils/firebase'
import { isPreInboundFollowSession, type TrendBucket, type TrendGranularity } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { shiftToTaipei, taipeiDateKey, taipeiDayEnd, taipeiDayStart } from '~~/server/utils/taipei-day'

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
  let ref = db.collection('conversationSessions') as FirebaseFirestore.Query
  ref = ref.where('workspaceId', '==', workspaceId)

  // 日界線取台北時間，與 kpi.get.ts 同修（見 taipei-day.ts）
  const startDate = taipeiDayStart(query.startDate)
    ?? taipeiDayStart(taipeiDateKey(new Date(Date.now() - 29 * 24 * 3600_000)))!
  const endDate = taipeiDayEnd(query.endDate) ?? new Date()

  ref = ref.where('openedAt', '>=', startDate).where('openedAt', '<=', endDate)

  // 新朋友按同一套桶分（與 KPI 卡同資料源 users.createdAt）。
  // 查失敗回 null → 整批省略 newFriends 欄位：圖上缺線比畫假的 0 線誠實。
  const friendsPromise = db.collection('users')
    .where('workspaceId', '==', workspaceId)
    .where('createdAt', '>=', startDate)
    .where('createdAt', '<=', endDate)
    .select('createdAt')
    .get()
    .then(s => s.docs.map(d => d.data().createdAt?.toDate?.()).filter(Boolean) as Date[])
    .catch((e) => {
      console.error('[conversation-stats] trend newFriends error:', e)
      return null
    })

  const [snap, friendDates] = await Promise.all([ref.get(), friendsPromise])
  const bucketMap = new Map<string, TrendBucket>()
  const emptyBucket = (key: string): TrendBucket => ({
    date: key, total: 0, bot: 0, ai: 0, human: 0, unhandled: 0, handoff: 0, closed: 0,
    ...(friendDates ? { newFriends: 0 } : {}),
  })

  for (const doc of snap.docs) {
    const s = doc.data()
    const ts = s.openedAt?.toDate?.()
    if (!ts) continue
    // 與 KPI 同口徑:活動/加好友出生、客人未開口的 session 不進統計
    if (isPreInboundFollowSession(s)) continue

    const key = bucketKey(ts, granularity)
    if (!bucketMap.has(key)) {
      bucketMap.set(key, emptyBucket(key))
    }
    const bucket = bucketMap.get(key)!
    bucket.total++
    if (s.initialHandler === 'bot') bucket.bot++
    else if (s.initialHandler === 'ai') bucket.ai++
    else if (s.initialHandler === 'human') bucket.human++
    else bucket.unhandled++
    if (s.hasHandoff) bucket.handoff++
    if (s.status === 'closed') bucket.closed++
  }

  // 新朋友入桶：只有好友沒有對話的日子也要有桶（活動日常見：加了一堆好友、還沒人開口）
  if (friendDates) {
    for (const d of friendDates) {
      const key = bucketKey(d, granularity)
      if (!bucketMap.has(key)) bucketMap.set(key, emptyBucket(key))
      const bucket = bucketMap.get(key)!
      bucket.newFriends = (bucket.newFriends ?? 0) + 1
    }
  }

  const buckets = Array.from(bucketMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v)

  return { buckets }
})
