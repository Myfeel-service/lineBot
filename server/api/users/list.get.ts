import { getDb } from '~~/server/utils/firebase'
import { parseAdminListPagination } from '~~/server/utils/admin-pagination'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'

const CHUNK = 30
const FETCH_BATCH = 120
/**
 * 「沒有搜尋、沒有標籤篩選」時只取清單用得到的欄位。
 * 客人文件上還有備註、標籤建議、綁定資料等清單不看的東西；一頁 20~50 筆時
 * 光是少搬這些就明顯有感（2026-08-27 實測見 docs/ADMIN-PERF-AUDIT-20260827.md）。
 */
const LIST_FIELDS = ['displayName', 'pictureUrl', 'createdAt', 'isBlocked', 'lineUserId'] as const
/**
 * 快路徑需要 `users (workspaceId, isBlocked, createdAt DESC)` 這個索引。索引還沒建好時
 * 程式會自動退回掃描路徑（見 `fetchUserPageDirect`），但**每次請求都先白撞一次失敗查詢**
 * ＝多花一趟往返（實測好友頁多 0.4 秒）。撞到就先記下來，這段時間內直接走掃描路徑。
 * 只存在記憶體、每個執行實例各自記；索引建好之後最多等這麼久就會自動改走快路徑。
 */
const FAST_PATH_RETRY_MS = 10 * 60_000
let fastPathBlockedUntil = 0

const MAX_SEARCH_SCAN = 5000
/**
 * 已知 id 集合小於這個數就走「主鍵直讀」快路徑（getAll）而不是掃 users。
 *
 * ⛔ 為什麼一定要有這條：`filterUserIds` 已經是精確的 id 集合，卻丟給 `offset()` 分頁掃描＝
 * 為了 3 筆結果掃 5,000 筆、而 offset 跳過的每一筆都計費（2026-08-11 讀取費暴衝的同款）。
 * 直讀還順便讓 `total` 精確、不受 MAX_SEARCH_SCAN 截斷。
 */
const FAST_PATH_MAX_IDS = 500
/** getAll 一次的批量 */
const GETALL_CHUNK = 300

function tsToMs(raw: unknown): number {
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number } | null | undefined
  if (!v) return 0
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

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
 * 取得好友列表，含每位用戶的標籤資訊
 *
 * Query:
 *   tagIds    - 以逗號分隔的 tagId，只回傳擁有其中任一標籤的用戶
 *   search    - 顯示名稱或 userId 關鍵字（不分大小寫）
 *   suggested - '1' 時只回傳「有待處理 AI 標籤建議」的用戶（收件匣入口，G-20③）
 *   page      - 頁碼（預設 1）
 *   limit     - 每頁筆數（預設 50，上限 100）
 *
 * Response: { users, total, page, limit, truncated, pendingSuggestionTotal }
 *   pendingSuggestionTotal - 全工作區還有幾位客人的 AI 建議等人決定（**不吃畫面篩選**，見下方註解）
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
  const onlySuggested = String(query.suggested || '') === '1'

  /**
   * 還有幾位客人的 AI 建議等人決定——給列表頂端那條待辦用。
   *
   * ⛔ **刻意不吃畫面上的篩選**：它回答的是「還有幾件事等你決定」，不是「這一頁有幾件」。
   *    跟著篩選變小會讓人以為已經處理掉了。
   * 成本：`onlySuggested` 時直接用已經撈回來的那份名單（零額外讀取）；其餘走 count 聚合
   *    ＝1 次讀取，而**這一次本來就在問了**（原本只拿它判斷「有沒有」，數字算出來就丟掉）。
   */
  let pendingSuggestionTotal = 0

  if (onlySuggested) {
    const snap = await db.collection('userTagSuggestions')
      .where('workspaceId', '==', workspaceId)
      .where('hasPending', '==', true)
      .get()
    const suggestedIds = new Set(snap.docs.map(d => d.id))
    // ⛔ 取交集**之前**先記數：交集後是「這個篩選下還剩幾位」，不是待辦總數
    pendingSuggestionTotal = suggestedIds.size
    filterUserIds = filterUserIds
      ? new Set([...filterUserIds].filter(id => suggestedIds.has(id)))
      : suggestedIds
  }
  else {
    pendingSuggestionTotal = await db.collection('userTagSuggestions')
      .where('workspaceId', '==', workspaceId)
      .where('hasPending', '==', true)
      .count()
      .get()
      .then(s => s.data().count)
      .catch(() => 0) // 探測失敗只是少一條待辦，不該讓整個列表壞掉
  }

  let users: UserBase[]
  let total: number
  /** 快路徑的結果；null＝索引還沒好，落回下面的掃描路徑 */
  let fast: { users: UserBase[], total: number } | null = null
  /** true＝掃描撞到上限，結果與總數都可能不完整（別讓畫面把「掃不完」講成「沒有」） */
  let truncated = false

  const fastPathIds = filterUserIds && filterUserIds.size <= FAST_PATH_MAX_IDS
    ? [...filterUserIds]
    : null

  if (fastPathIds) {
    // id 已知 → 主鍵直讀，總數精確、不掃 users、不用 offset
    const matched = await fetchUsersByIds({ db, workspaceId, ids: fastPathIds, searchRaw })
    total = matched.length
    users = matched.slice(offset, offset + limit)
  }
  else if (!searchRaw && !filterUserIds && (fast = await fetchUserPageDirect({ db, workspaceId, offset, limit }))) {
    // 最常見的那種請求（好友頁直接開）：不必掃描，資料庫那一頁就是答案
    users = fast.users
    total = fast.total
    truncated = false
  }
  else {
    users = await fetchUserPage({ db, workspaceId, offset, limit, filterUserIds, searchRaw })
    const counted = await countMatchingUsers({ db, workspaceId, filterUserIds, searchRaw })
    total = counted.count
    truncated = counted.truncated
  }

  // ⛔ 空結果也要帶待辦總數：篩到沒東西時那條待辦更該在（那正是「我是不是漏了什麼」的時候）
  if (!users.length) return { users: [], total, page, limit, truncated, pendingSuggestionTotal }

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

  /**
   * 收件匣入口（G-20③）：這一頁的客人各自有沒有待處理的 AI 建議。
   *
   * ⛔ 先用 `count()` 探一次再決定要不要逐筆讀：`autoTagSuggest` **預設關**，沒開過的工作區
   * 這個集合是空的，逐筆 getAll 等於每次翻頁都白付 50~100 次讀取（而且是在一個跟 AI 建議
   * 無關的頁面上）。count 聚合不論命中幾筆都只算 1 次讀取，先問「這個工作區到底有沒有」最便宜。
   * `suggested=1` 時整頁必然都是 true（篩選本身就是這個條件），連 count 都不用問。
   */
  const suggestedIds = new Set<string>()
  if (onlySuggested) {
    userIds.forEach(id => suggestedIds.add(id))
  }
  // 上面算待辦總數時已經問過「這個工作區有沒有」了，這裡直接沿用，不要再問一次
  else if (pendingSuggestionTotal > 0) {
    const sugSnaps = await db.getAll(...userIds.map(id => db.collection('userTagSuggestions').doc(id)))
    for (const s of sugSnaps) {
      if (s.exists && s.data()?.hasPending === true) suggestedIds.add(s.id)
    }
  }

  const enriched = users.map((user) => {
    const tagIds = userTagMap[user.id] ?? []
    return {
      ...user,
      tagIds,
      hasTagSuggestions: suggestedIds.has(user.id),
      tags: tagIds.map((tid) => tagMap[tid]).filter(Boolean).map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        category: t.category,
        color: t.color,
      })),
    }
  })

  return { users: enriched, total, page, limit, truncated, pendingSuggestionTotal }
})

/**
 * 主鍵直讀一批客人（快路徑）：id 已知時不該去掃 users。
 * 排序與掃描路徑一致（加入時間新→舊），這樣切換條件時清單順序不會忽然變一種邏輯。
 */
async function fetchUsersByIds(opts: {
  db: FirebaseFirestore.Firestore
  workspaceId: string
  ids: string[]
  searchRaw: string
}): Promise<UserBase[]> {
  const { db, workspaceId, ids, searchRaw } = opts
  const out: UserBase[] = []

  for (let i = 0; i < ids.length; i += GETALL_CHUNK) {
    const refs = ids.slice(i, i + GETALL_CHUNK).map(id => db.collection('users').doc(id))
    if (!refs.length) continue
    const snaps = await db.getAll(...refs)
    for (const d of snaps) {
      if (!d.exists) continue
      const data = d.data()!
      // 主鍵本身含租戶前綴，這裡再驗一次是保險（最早期的 doc 可能沒有這個欄位，缺欄不擋）
      if (data.workspaceId && data.workspaceId !== workspaceId) continue
      if (data.isBlocked === true) continue
      const user: UserBase = {
        id: d.id,
        lineUserId: String(data.lineUserId || '').trim() || lineUserIdFromFirestoreDocId(d.id, workspaceId),
        displayName: data.displayName ?? d.id,
        pictureUrl: data.pictureUrl ?? '',
        createdAt: data.createdAt ?? null,
        isBlocked: false,
      }
      if (!matchesSearch(user, searchRaw)) continue
      out.push(user)
    }
  }

  out.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))
  return out
}

/**
 * 沒有搜尋也沒有標籤篩選時的快路徑（＝好友頁最常見的那一種請求）。
 *
 * ⛔ 為什麼要跟掃描路徑分開：掃描版一律從第 1 筆開始、一批 120 筆撈回**整份文件**再在
 * 記憶體裡篩，為了 20 筆結果讀 120 筆；而沒有篩選條件時完全不需要掃描——Firestore
 * 那一頁本來就是答案。這裡改成「從這一頁的位置直接取 limit＋緩衝、只取需要的欄位」。
 *
 * ⚠️ `offset()` 跳過的每一筆仍然計費（見記憶 project_firestore_read_cost_20260811），
 * 所以這只解決「為 20 筆讀 120 筆」，翻很深的頁還是貴。要連那個也解掉得改成游標分頁，
 * 但頁碼式分頁（可以直接跳第 5 頁）就沒辦法用游標——那是另一筆帳（`E-26` 註記）。
 */
async function fetchUserPageDirect(opts: {
  db: FirebaseFirestore.Firestore
  workspaceId: string
  offset: number
  limit: number
}): Promise<{ users: UserBase[], total: number } | null> {
  const { db, workspaceId, offset, limit } = opts
  // ⛔ 封鎖的客人要在**查詢層**就排掉，不可以撈回來再於記憶體篩：
  //    在記憶體篩的話「這一頁的第幾筆」跟「資料庫的第幾筆」就對不上，
  //    補滿一頁會借到下一頁的第一筆 → 翻頁時同一個人出現兩次（正式資料實測到過）。
  //    可以這樣查是因為 isBlocked 建檔時一定會寫（handler.ts 建立客人時 `isBlocked: false`），
  //    不存在「沒有這個欄位所以被等值查詢靜靜排除」的舊資料（實測 4,697 筆全部有）。
  if (Date.now() < fastPathBlockedUntil)
    return null // 剛剛才確認過索引還沒好，先不要再白撞一次

  const base = db.collection('users')
    .where('workspaceId', '==', workspaceId)
    .where('isBlocked', '==', false)

  let ref = base.orderBy('createdAt', 'desc').select(...LIST_FIELDS) as FirebaseFirestore.Query
  if (offset > 0) ref = ref.offset(offset)

  try {
    const [snap, total] = await Promise.all([
      ref.limit(limit).get(),
      base.count().get().then(s => s.data().count),
    ])
    return {
      total,
      users: snap.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          lineUserId: String(data.lineUserId || '').trim() || lineUserIdFromFirestoreDocId(d.id, workspaceId),
          displayName: data.displayName ?? d.id,
          pictureUrl: data.pictureUrl ?? '',
          createdAt: data.createdAt ?? null,
          isBlocked: false,
        }
      }),
    }
  }
  catch (e: any) {
    // 索引還沒建好／還在建（FAILED_PRECONDITION）→ 回 null 讓呼叫端走原本的掃描路徑。
    // 部署順序不必綁：程式先上也不會壞，索引建好之後自動走快路徑。
    fastPathBlockedUntil = Date.now() + FAST_PATH_RETRY_MS
    console.warn('[users/list] 快路徑不可用，退回掃描：', String(e?.message).slice(0, 160))
    return null
  }
}

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

/**
 * 掃描路徑的總數。回 `truncated` 是刻意的——撞到 MAX_SEARCH_SCAN 時「0 筆」的意思是
 * 「掃不完、沒找到」而不是「真的沒有」，畫面要有辦法分辨（同 conversations/list 的做法）。
 */
async function countMatchingUsers(opts: {
  db: FirebaseFirestore.Firestore
  workspaceId: string
  filterUserIds: Set<string> | null
  searchRaw: string
}): Promise<{ count: number; truncated: boolean }> {
  const { db, workspaceId, filterUserIds, searchRaw } = opts

  if (!searchRaw && !filterUserIds) {
    const snap = await db.collection('users')
      .where('workspaceId', '==', workspaceId)
      .count()
      .get()
    return { count: snap.data().count, truncated: false }
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

  return { count, truncated: scanned >= MAX_SEARCH_SCAN }
}
