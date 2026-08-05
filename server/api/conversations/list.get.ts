import { getDb } from '~~/server/utils/firebase'
import { parseAdminListPagination } from '~~/server/utils/admin-pagination'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

const DISPLAY_FALLBACK = 'LINE 用戶'
const FETCH_BATCH = 80
const MAX_SEARCH_SCAN = 3000

type ConvRow = {
  userId: string
  displayName: string
  pictureUrl: string
  lastMessage: string
  lastDirection: string
  lastMessageAt: unknown
  /** 客人已封鎖官方帳號（unfollow 時寫入）：推播會被 LINE 退件，客服要先知道 */
  isBlocked: boolean
}

function matchesSearch(row: ConvRow, searchRaw: string): boolean {
  if (!searchRaw) return true
  return row.displayName.toLowerCase().includes(searchRaw)
    || row.userId.toLowerCase().includes(searchRaw)
}

async function enrichConversations(
  db: FirebaseFirestore.Firestore,
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
): Promise<ConvRow[]> {
  if (!docs.length) return []

  const userIds = docs.map(d => d.id)
  const CHUNK = 30
  const userMap: Record<string, any> = {}

  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK)
    const uSnap = await db.collection('users').where('__name__', 'in', chunk).get()
    uSnap.docs.forEach(d => { userMap[d.id] = d.data() })
  }

  return docs.map((d) => {
    const data = d.data()
    const user = userMap[d.id] ?? {}
    return {
      userId: d.id,
      displayName: String(user.displayName || '').trim() || DISPLAY_FALLBACK,
      pictureUrl: String(user.pictureUrl || '').trim(),
      lastMessage: data.lastMessage ?? '',
      lastDirection: data.lastDirection ?? 'incoming',
      lastMessageAt: data.lastMessageAt ?? null,
      // 這裡本來就撈了 user 文件，順手帶出來，不必為了這個旗標多打一次 Firestore
      isBlocked: user.isBlocked === true,
    }
  })
}

/**
 * GET /api/conversations/list
 * Query: page, limit, search
 * Response: { conversations, total, page, limit, hasMore }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const query = getQuery(event)
  const searchRaw = String(query.search || '').trim().toLowerCase()
  const { page, limit, offset } = parseAdminListPagination(query, { limit: 30 })

  const db = getDb()
  const baseRef = db.collection('conversations')
    .where('workspaceId', '==', workspaceId)
    .orderBy('lastMessageAt', 'desc')

  if (!searchRaw) {
    const countSnap = await baseRef.count().get()
    const total = countSnap.data().count

    let ref = baseRef as FirebaseFirestore.Query
    if (offset > 0) ref = ref.offset(offset)
    const snap = await ref.limit(limit).get()
    const conversations = await enrichConversations(db, snap.docs)
    const loaded = offset + conversations.length

    return {
      conversations,
      total,
      page,
      limit,
      hasMore: loaded < total,
    }
  }

  const matched: ConvRow[] = []
  let firestoreOffset = 0
  let scanned = 0
  let lastBatchFull = false

  while (matched.length < offset + limit && scanned < MAX_SEARCH_SCAN) {
    const snap = await baseRef.offset(firestoreOffset).limit(FETCH_BATCH).get()
    if (snap.empty) break
    scanned += snap.size
    firestoreOffset += snap.size
    lastBatchFull = snap.size >= FETCH_BATCH

    const rows = await enrichConversations(db, snap.docs)
    for (const row of rows) {
      if (!matchesSearch(row, searchRaw)) continue
      matched.push(row)
    }

    if (snap.size < FETCH_BATCH) break
  }

  const conversations = matched.slice(offset, offset + limit)
  const hitScanCap = scanned >= MAX_SEARCH_SCAN && lastBatchFull
  const total = matched.length
  const hasMore = matched.length > offset + limit || hitScanCap

  return {
    conversations,
    total,
    page,
    limit,
    hasMore,
  }
})
