import { getDb } from '~~/server/utils/firebase'
import { parseAdminListPagination } from '~~/server/utils/admin-pagination'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'

const CHUNK = 30
const FETCH_BATCH = 120
const MAX_SEARCH_SCAN = 5000

type UserBase = {
  /** Firestore doc id（{workspaceId}_{lineUserId}）——用於本系統的讀寫 */
  id: string
  /**
   * 純 LINE userId（Uxxx…）。呼叫 LINE API（推播、轉真人通知）只認這個，
   * 直接把 id 丟給 LINE 會被判成無效 userId。
   */
  lineUserId: string
  displayName: string
  pictureUrl: string
  createdAt: unknown
  isBlocked: boolean
}

function matchesSearch(user: UserBase, searchRaw: string): boolean {
  if (!searchRaw) return true
  const name = (user.displayName ?? '').toLowerCase()
  return name.includes(searchRaw) || user.id.toLowerCase().includes(searchRaw)
}

/**
 * GET /api/users/list
 * 取得會員列表，含每位用戶的標籤資訊
 *
 * Query:
 *   tagIds    - 以逗號分隔的 tagId，只回傳擁有其中任一標籤的用戶
 *   search    - 顯示名稱或 userId 關鍵字（不分大小寫）
 *   suggested - '1' 時只回傳「有待處理 AI 標籤建議」的用戶（收件匣入口，G-20③）
 *   page      - 頁碼（預設 1）
 *   limit     - 每頁筆數（預設 50，上限 100）
 *
 * Response: { users, total, page, limit }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const query = getQuery(event)
  const tagIdsParam = query.tagIds as string | undefined
  const searchRaw = String(query.search || '').trim().toLowerCase()
  const { page, limit, offset } = parseAdminListPagination(query)

  const db = getDb()

  let filterUserIds: Set<string> | null = null
  if (tagIdsParam) {
    const tagIds = tagIdsParam.split(',').filter(Boolean)
    if (tagIds.length > 0) {
      const snap = await db.collection('userTags')
        .where('workspaceId', '==', workspaceId)
        .where('tagId', 'in', tagIds.slice(0, 30))
        .get()
      filterUserIds = new Set(snap.docs.map((d) => d.data().userId as string))
    }
  }

  // 「只看有 AI 建議的」：hasPending 是寫入端維護的等值查詢欄位（Firestore 查不了「陣列非空」）。
  // 與標籤篩選同時開時取交集（兩個條件都要成立）
  if (String(query.suggested || '') === '1') {
    const snap = await db.collection('userTagSuggestions')
      .where('workspaceId', '==', workspaceId)
      .where('hasPending', '==', true)
      .get()
    const suggestedIds = new Set(snap.docs.map(d => d.id))
    filterUserIds = filterUserIds
      ? new Set([...filterUserIds].filter(id => suggestedIds.has(id)))
      : suggestedIds
  }

  const users = await fetchUserPage({
    db,
    workspaceId,
    offset,
    limit,
    filterUserIds,
    searchRaw,
  })

  const total = await countMatchingUsers({
    db,
    workspaceId,
    filterUserIds,
    searchRaw,
  })

  if (!users.length) return { users: [], total, page, limit }

  const userIds = users.map((u) => u.id)
  const allUserTags: Array<{ userId: string; tagId: string }> = []

  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK)
    const snap = await db.collection('userTags').where('userId', 'in', chunk).get()
    snap.docs.forEach((d) => {
      allUserTags.push({ userId: d.data().userId, tagId: d.data().tagId })
    })
  }

  const userTagMap: Record<string, string[]> = {}
  for (const ut of allUserTags) {
    ;(userTagMap[ut.userId] ??= []).push(ut.tagId)
  }

  const allTagIds = [...new Set(allUserTags.map((ut) => ut.tagId))]
  const tagMap: Record<string, any> = {}

  if (allTagIds.length > 0) {
    for (let i = 0; i < allTagIds.length; i += CHUNK) {
      const chunk = allTagIds.slice(i, i + CHUNK)
      const snap = await db.collection('tags').where('__name__', 'in', chunk).get()
      snap.docs.forEach((d) => {
        tagMap[d.id] = { id: d.id, ...d.data() }
      })
    }
  }

  // 收件匣入口（G-20③）：這一頁的用戶各自有沒有待處理的 AI 建議。
  // 主鍵直讀批次（getAll），一頁一批、零掃描
  const suggestFlags = new Map<string, boolean>()
  const sugSnaps = await db.getAll(...userIds.map(id => db.collection('userTagSuggestions').doc(id)))
  for (const s of sugSnaps) {
    if (s.exists && s.data()?.hasPending === true) suggestFlags.set(s.id, true)
  }

  const enriched = users.map((user) => {
    const tagIds = userTagMap[user.id] ?? []
    return {
      ...user,
      tagIds,
      hasTagSuggestions: suggestFlags.get(user.id) === true,
      tags: tagIds.map((tid) => tagMap[tid]).filter(Boolean).map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        category: t.category,
        color: t.color,
      })),
    }
  })

  return { users: enriched, total, page, limit }
})

async function fetchUserPage(opts: {
  db: FirebaseFirestore.Firestore
  workspaceId: string
  offset: number
  limit: number
  filterUserIds: Set<string> | null
  searchRaw: string
}): Promise<UserBase[]> {
  const { db, workspaceId, offset, limit, filterUserIds, searchRaw } = opts
  const collected: UserBase[] = []
  let skipped = 0
  let firestoreOffset = 0
  let scanned = 0

  while (collected.length < limit && scanned < MAX_SEARCH_SCAN) {
    const snap = await db.collection('users')
      .where('workspaceId', '==', workspaceId)
      .orderBy('createdAt', 'desc')
      .offset(firestoreOffset)
      .limit(FETCH_BATCH)
      .get()

    if (snap.empty) break
    scanned += snap.size
    firestoreOffset += snap.size

    for (const d of snap.docs) {
      if (d.data().isBlocked === true) continue
      const user: UserBase = {
        id: d.id,
        lineUserId: String(d.data().lineUserId || '').trim()
          || lineUserIdFromFirestoreDocId(d.id, workspaceId),
        displayName: d.data().displayName ?? d.id,
        pictureUrl: d.data().pictureUrl ?? '',
        createdAt: d.data().createdAt ?? null,
        isBlocked: false,
      }
      if (filterUserIds && !filterUserIds.has(user.id)) continue
      if (!matchesSearch(user, searchRaw)) continue
      if (skipped < offset) {
        skipped++
        continue
      }
      collected.push(user)
      if (collected.length >= limit) break
    }

    if (snap.size < FETCH_BATCH) break
  }

  return collected
}

async function countMatchingUsers(opts: {
  db: FirebaseFirestore.Firestore
  workspaceId: string
  filterUserIds: Set<string> | null
  searchRaw: string
}): Promise<number> {
  const { db, workspaceId, filterUserIds, searchRaw } = opts

  if (!searchRaw && !filterUserIds) {
    const snap = await db.collection('users')
      .where('workspaceId', '==', workspaceId)
      .count()
      .get()
    return snap.data().count
  }

  let count = 0
  let firestoreOffset = 0
  let scanned = 0

  while (scanned < MAX_SEARCH_SCAN) {
    const snap = await db.collection('users')
      .where('workspaceId', '==', workspaceId)
      .orderBy('createdAt', 'desc')
      .offset(firestoreOffset)
      .limit(FETCH_BATCH)
      .get()

    if (snap.empty) break
    scanned += snap.size
    firestoreOffset += snap.size

    for (const d of snap.docs) {
      if (d.data().isBlocked === true) continue
      const user: UserBase = {
        id: d.id,
        lineUserId: String(d.data().lineUserId || '').trim()
          || lineUserIdFromFirestoreDocId(d.id, workspaceId),
        displayName: d.data().displayName ?? d.id,
        pictureUrl: d.data().pictureUrl ?? '',
        createdAt: d.data().createdAt ?? null,
        isBlocked: false,
      }
      if (filterUserIds && !filterUserIds.has(user.id)) continue
      if (!matchesSearch(user, searchRaw)) continue
      count++
    }

    if (snap.size < FETCH_BATCH) break
  }

  return count
}
