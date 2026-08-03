import { getDb } from '~~/server/utils/firebase'
import type { ConversationStatus, InitialHandler } from '~~/shared/types/conversation-stats'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { countOpenQueueSessions, isOpenQueueSession, scanFilteredPage } from '~~/server/utils/conversation-queue'

const PAGE_SIZE = 30
const CHUNK = 30
const FALLBACK_MAX_FETCH = 1000
const DISPLAY_FALLBACK = 'LINE 用戶'

function uniqueFirestoreUserIds(rawIds: string[], workspaceId: string): string[] {
  return [...new Set(rawIds.map(uid => lineUserFirestoreDocId(uid, workspaceId)))]
}

function mapSessionToRow(
  sessionDocId: string,
  s: Record<string, unknown>,
  userMap: Record<string, Record<string, unknown> | undefined>,
  workspaceId: string,
) {
  const fsUid = lineUserFirestoreDocId(String(s.userId || ''), workspaceId)
  const user = userMap[fsUid] ?? {}
  const displayName = String(user.displayName || '').trim() || DISPLAY_FALLBACK
  return {
    sessionId: sessionDocId,
    userId: fsUid,
    displayName,
    pictureUrl: String(user.pictureUrl || '').trim(),
    status: s.status,
    initialHandler: s.initialHandler,
    currentHandler: s.currentHandler,
    initialModuleType: s.initialModuleType,
    currentModuleType: s.currentModuleType,
    hasHandoff: s.hasHandoff,
    openedAt: s.openedAt ?? null,
    closedAt: s.closedAt ?? null,
    lastActivityAt: s.lastActivityAt ?? null,
  }
}

function toMillis(raw: any): number {
  if (!raw) return 0
  if (raw instanceof Date) return raw.getTime()
  if (typeof raw?.toMillis === 'function') return raw.toMillis()
  if (typeof raw?.toDate === 'function') return raw.toDate()?.getTime?.() ?? 0
  const parsed = new Date(raw)
  const t = parsed.getTime()
  return Number.isFinite(t) ? t : 0
}

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const query = getQuery(event)
  const db = getDb()

  const status = String(query.status || 'all')
  const initialHandler = String(query.initialHandler || 'all')
  const hasHandoff = query.hasHandoff === 'true' ? true : query.hasHandoff === 'false' ? false : undefined
  const page = Math.max(1, Number(query.page || 1))
  const limit = Math.min(100, Math.max(1, Number(query.limit || PAGE_SIZE)))

  const offset = (page - 1) * limit

  const startDate = query.startDate ? new Date(String(query.startDate)) : null
  const endDate = query.endDate ? new Date(String(query.endDate)) : null
  if (endDate) endDate.setHours(23, 59, 59, 999)
  const startMs = startDate ? startDate.getTime() : null
  const endMs = endDate ? endDate.getTime() : null

  // 「未首接」分頁是待處理佇列:活動/加好友出生、客人未開口的 session 不佔佇列
  // (客人開口後 hasInbound=true 自然回歸;「全部」分頁仍看得到)
  const isOpenQueue = status === 'open'

  // Firestore composite indexes are painful during local dev and can break admin pages.
  // Strategy: try the "ideal" query first; if it fails with FAILED_PRECONDITION (missing index),
  // fall back to a safe query (status-only) and do the rest in memory.
  const runFallback = async () => {
    let safeRef = db.collection('conversationSessions') as FirebaseFirestore.Query
    safeRef = safeRef.where('workspaceId', '==', workspaceId)
    if (status !== 'all') {
      safeRef = safeRef.where('status', '==', status as ConversationStatus)
    }
    safeRef = safeRef.limit(FALLBACK_MAX_FETCH)
    const safeSnap = await safeRef.get()
    if (safeSnap.empty) return { sessions: [], total: 0, page, limit, hasMore: false, truncated: false }

    const filtered = safeSnap.docs
      .map(d => ({ id: d.id, data: d.data() as any }))
      .filter(({ data }) => {
        if (isOpenQueue && !isOpenQueueSession(data)) return false
        if (initialHandler !== 'all' && data.initialHandler !== initialHandler) return false
        if (hasHandoff !== undefined && Boolean(data.hasHandoff) !== hasHandoff) return false
        const t = toMillis(data.lastActivityAt)
        if (startMs !== null && t < startMs) return false
        if (endMs !== null && t > endMs) return false
        return true
      })
      .sort((a, b) => toMillis(b.data.lastActivityAt) - toMillis(a.data.lastActivityAt))

    const sliced = filtered.slice(offset, offset + limit)
    if (sliced.length === 0) {
      return {
        sessions: [],
        total: filtered.length,
        page,
        limit,
        hasMore: false,
        truncated: filtered.length >= FALLBACK_MAX_FETCH,
      }
    }

    const rawUserIds = sliced.map(x => String(x.data.userId || '')).filter(Boolean)
    const fsUserIds = uniqueFirestoreUserIds(rawUserIds, workspaceId)
    const userMap: Record<string, Record<string, unknown> | undefined> = {}
    for (let i = 0; i < fsUserIds.length; i += CHUNK) {
      const chunk = fsUserIds.slice(i, i + CHUNK)
      const uSnap = await db.collection('users').where('__name__', 'in', chunk).get()
      uSnap.docs.forEach(d => { userMap[d.id] = d.data() })
    }

    const sessions = sliced.map(({ id, data: s }) => mapSessionToRow(id, s, userMap, workspaceId))

    const loaded = offset + sessions.length
    return {
      sessions,
      total: filtered.length,
      page,
      limit,
      hasMore: loaded < filtered.length,
      truncated: filtered.length >= FALLBACK_MAX_FETCH,
    }
  }

  try {
    let ref = db.collection('conversationSessions') as FirebaseFirestore.Query
    ref = ref.where('workspaceId', '==', workspaceId)

    if (status !== 'all') {
      ref = ref.where('status', '==', status as ConversationStatus)
    }
    if (initialHandler !== 'all') {
      ref = ref.where('initialHandler', '==', initialHandler as InitialHandler)
    }
    if (hasHandoff !== undefined) {
      ref = ref.where('hasHandoff', '==', hasHandoff)
    }
    if (startDate) {
      ref = ref.where('lastActivityAt', '>=', startDate)
    }
    if (endDate) {
      ref = ref.where('lastActivityAt', '<=', endDate)
    }

    ref = ref.orderBy('lastActivityAt', 'desc')

    let docs: FirebaseFirestore.QueryDocumentSnapshot[]
    let total: number
    let hasMore: boolean
    let truncated = false

    if (isOpenQueue) {
      // 過濾在分頁之前:每頁都是實打實的 limit 筆,總數才對得上列表
      const scanned = await scanFilteredPage<FirebaseFirestore.QueryDocumentSnapshot>(
        ref, isOpenQueueSession, offset, limit,
      )
      docs = scanned.docs
      hasMore = scanned.hasMore
      truncated = scanned.truncated
      total = (startDate || endDate)
        // 帶日期時算不出精確佇列數(範圍+等值需複合索引),用已載入筆數當下限,不假裝知道
        ? offset + docs.length + (hasMore ? 1 : 0)
        : await countOpenQueueSessions(db, workspaceId)
    }
    else {
      const countSnap = await ref.count().get()
      total = countSnap.data().count

      let pageRef = ref
      if (offset > 0) {
        // Use offset pagination for simplicity (Firestore supports up to 1000)
        pageRef = pageRef.offset(offset)
      }
      const snap = await pageRef.limit(limit).get()
      docs = snap.docs
      hasMore = offset + docs.length < total
    }

    if (docs.length === 0) return { sessions: [], total, page, limit, hasMore: false, truncated }

    const rawUserIds = docs.map(d => String(d.data().userId || '')).filter(Boolean)
    const fsUserIds = uniqueFirestoreUserIds(rawUserIds, workspaceId)
    const userMap: Record<string, Record<string, unknown> | undefined> = {}
    for (let i = 0; i < fsUserIds.length; i += CHUNK) {
      const chunk = fsUserIds.slice(i, i + CHUNK)
      const uSnap = await db.collection('users').where('__name__', 'in', chunk).get()
      uSnap.docs.forEach(d => { userMap[d.id] = d.data() })
    }

    const sessions = docs.map(d => mapSessionToRow(d.id, d.data(), userMap, workspaceId))

    return { sessions, total, page, limit, hasMore, truncated }
  }
  catch (e: any) {
    const msg = String(e?.message || '')
    const code = Number(e?.code || 0)
    const isMissingIndex = code === 9 && /requires an index/i.test(msg)
    if (isMissingIndex) {
      console.warn('[sessions.get] missing composite index, using fallback query:', msg.slice(0, 300))
      return await runFallback()
    }
    throw e
  }
})
