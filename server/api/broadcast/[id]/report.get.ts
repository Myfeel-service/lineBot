import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { fetchBroadcastLineInsight } from '~~/server/utils/broadcast-line-insight'
import { lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import type { BroadcastDoc } from '~~/shared/types/tag-broadcast'

/** 「沒收到的人」最多列這麼多位，避免大量失敗時一次抓爆 */
const FAILED_LIST_LIMIT = 100

/**
 * 取「沒收到的人」並補上暱稱，供後台直接跟進（多半是對方封鎖了官方帳號）。
 * deliveries 只記失敗者；成功者不逐筆記錄（受眾名單本身已存在 audienceSnapshot）。
 */
async function fetchFailedRecipients(
  db: FirebaseFirestore.Firestore,
  campaignId: string,
  workspaceId: string,
): Promise<{ lineUserId: string; displayName: string }[]> {
  const snap = await db.collection('broadcasts').doc(campaignId).collection('deliveries')
    .where('deliveryStatus', '==', 'failed')
    .limit(FAILED_LIST_LIMIT)
    .get()

  const docIds = [...new Set(
    snap.docs.map(d => String(d.data().userId || '').trim()).filter(Boolean),
  )]
  if (!docIds.length) return []

  const userSnaps = await db.getAll(...docIds.map(uid => db.collection('users').doc(uid)))

  return docIds.map((docId, i) => {
    const data = userSnaps[i]?.data()
    const lineUserId = String(data?.lineUserId || '').trim()
      || lineUserIdFromFirestoreDocId(docId, workspaceId)
    return {
      lineUserId,
      displayName: String(data?.displayName || '').trim() || lineUserId,
    }
  })
}

function firestoreTimeToDate(v: unknown): Date | null {
  if (v == null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof (v as { toDate?: () => Date }).toDate === 'function') {
    try {
      const d = (v as { toDate: () => Date }).toDate()
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null
    }
    catch {
      return null
    }
  }
  const o = v as { seconds?: number; _seconds?: number }
  const sec = typeof o.seconds === 'number' ? o.seconds : typeof o._seconds === 'number' ? o._seconds : NaN
  if (!Number.isNaN(sec)) return new Date(sec * 1000)
  return null
}

/**
 * GET /api/broadcast/:id/report
 * 取得推播成效報表
 *
 * - linkClickCount：經 /api/r 追蹤連結的點擊（自家 log）
 * - lineUniqueImpression：LINE 聚合「開封」人數（可能為 null，小樣本隱私）
 * - lineUniqueClick：LINE 聚合「訊息內網址點擊」人數（與自架追蹤不同）
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const db = getDb()
  const snap = await db.collection('broadcasts').doc(id).get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })

  const data = snap.data() as BroadcastDoc
  if (data.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Broadcast not found' })
  }

  const clickSnap = await db.collection('broadcastClickLogs')
    .where('campaignId', '==', id)
    .get()

  const clicksByLinkKey: Record<string, number> = {}
  for (const doc of clickSnap.docs) {
    const linkKey = doc.data().linkKey as string
    clicksByLinkKey[linkKey] = (clicksByLinkKey[linkKey] ?? 0) + 1
  }

  const linkClickCount = clickSnap.size
  const linkCtr = data.sentCount > 0 ? linkClickCount / data.sentCount : 0

  // 沒失敗就不必多跑一次查詢
  const failedRecipients = data.failedCount > 0
    ? await fetchFailedRecipients(db, id, workspaceId)
    : []

  const startedAt = firestoreTimeToDate(data.startedAt as unknown)
  const completedAt = firestoreTimeToDate(data.completedAt as unknown)

  const shouldFetchLine = ['completed', 'failed'].includes(data.status)
  /** 曾改走無彙總 multicast 時為 false，LINE 不會有該 unit 的 insight */
  const skipLineInsight = data.lineInsightAggregationApplied === false
  const line = shouldFetchLine
    ? (skipLineInsight
        ? {
            lineUniqueImpression: null as number | null,
            lineUniqueClick: null as number | null,
            lineInsightError: 'LINE_AGGREGATION_SKIPPED',
          }
        : await fetchBroadcastLineInsight(
            id,
            String(data.workspaceId || '').trim(),
            data.lineAggregationUnit ?? null,
            startedAt,
            completedAt,
          ))
    : { lineUniqueImpression: null as number | null, lineUniqueClick: null as number | null }

  const openRate = line.lineUniqueImpression != null && data.sentCount > 0
    ? line.lineUniqueImpression / data.sentCount
    : null

  return {
    campaignId: id,
    name: data.name,
    status: data.status,
    totalCount: data.totalCount,
    sentCount: data.sentCount,
    failedCount: data.failedCount,
    skippedCount: data.skippedCount,
    /** 自架追蹤連結（/api/r）點擊次數 */
    linkClickCount,
    /** 與 linkClickCount 相同，保留相容 */
    clickCount: linkClickCount,
    /** 自架連結 CTR */
    ctr: Math.round(linkCtr * 10000) / 10000,
    /** LINE 開封人數（uniqueImpression），聚合非即時、小樣本可能為 null */
    lineUniqueImpression: line.lineUniqueImpression,
    /** LINE 官方統計之訊息內網址點擊人數（與 linkClickCount 分開） */
    lineUniqueClick: line.lineUniqueClick,
    lineInsightError: line.lineInsightError,
    /** 訊息已送出但發送後記帳未寫完（沒收到的名單可能不全，成功／失敗數仍有效） */
    postSendError: data.postSendError ?? null,
    /** 沒收到的人（最多 FAILED_LIST_LIMIT 位），可直接跟進 */
    failedRecipients,
    /** 失敗人數超過列出上限時為 true，總數看 failedCount */
    failedRecipientsTruncated: data.failedCount > failedRecipients.length,
    openRate: openRate != null ? Math.round(openRate * 10000) / 10000 : null,
    clicksByLinkKey,
    startedAt: data.startedAt,
    completedAt: data.completedAt,
    lineAggregationUnit: data.lineAggregationUnit ?? null,
    lineInsightAggregationApplied:
      typeof data.lineInsightAggregationApplied === 'boolean'
        ? data.lineInsightAggregationApplied
        : (data.lineAggregationUnit ? true : null),
  }
})
