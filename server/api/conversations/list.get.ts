import { getDb } from '~~/server/utils/firebase'
import { parseAdminListPagination } from '~~/server/utils/admin-pagination'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import {
  MAX_PINNED_CONVERSATIONS,
  FOLLOW_UP_LIST_LIMIT,
  readConversationFlags,
  withPinnedFirst,
} from '~~/shared/conversation-flags'
import { readConversationAssignee, type ConversationAssignee } from '~~/shared/conversation-assignee'

const DISPLAY_FALLBACK = 'LINE 用戶'
/**
 * 搜尋命中數上限。名字搜尋命中通常是個位數；會撞到這個數字的是「u」「a」這種
 * 打中一堆 LINE userId 的單字母，那種結果本來就沒人要翻完，截斷後 truncated 帶回去明講。
 */
const MAX_SEARCH_MATCHES = 500

type ConvRow = {
  userId: string
  displayName: string
  pictureUrl: string
  lastMessage: string
  lastDirection: string
  lastMessageAt: unknown
  /**
   * 客人最後一則訊息的時間＝未讀紅點比的那個值（見 shared/conversation-unread.ts）。
   * null＝客人沒開過口，或這是 2026-08-19 之前的舊對話（前端有退路）。
   */
  customerLastAt: unknown
  /** 客人已封鎖官方帳號（unfollow 時寫入）：推播會被 LINE 退件，客服要先知道 */
  isBlocked: boolean
  /** 人工標記：釘在列表最上面（全 workspace 共用） */
  pinned: boolean
  /** 人工標記：客服手動標「我要回頭跟這筆」，與會話狀態無關（見 shared/conversation-flags.ts） */
  followUp: boolean
  /** 負責人員：哪一位同事在跟這條線（見 shared/conversation-assignee.ts）；沒人負責時 uid 為空字串 */
  assignee: ConversationAssignee
}

/** 搜尋結果在記憶體排序用：lastMessageAt 是 Firestore Timestamp，沒有的排最後 */
function timestampMillis(v: unknown): number {
  const ts = v as { toMillis?: () => number } | null
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : 0
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
    const flags = readConversationFlags(data)
    return {
      userId: d.id,
      displayName: String(user.displayName || '').trim() || DISPLAY_FALLBACK,
      pictureUrl: String(user.pictureUrl || '').trim(),
      lastMessage: data.lastMessage ?? '',
      lastDirection: data.lastDirection ?? 'incoming',
      lastMessageAt: data.lastMessageAt ?? null,
      customerLastAt: data.lastInboundMessageAt ?? null,
      // 這裡本來就撈了 user 文件，順手帶出來，不必為了這個旗標多打一次 Firestore
      isBlocked: user.isBlocked === true,
      pinned: flags.pinned,
      followUp: flags.followUp,
      assignee: readConversationAssignee(data),
    }
  })
}

/**
 * 依人工標記欄位排序取回（釘選 / 待跟進）。
 *
 * `orderBy(field)` 本身就會排除沒有這個欄位的文件，取消標記是 FieldValue.delete()，
 * 所以這條查詢回來的就是「目前有標記的那些」。
 * 缺複合索引時回 null（不是空陣列）：呼叫端才分得出「沒有人標記」和「查不到」。
 */
async function queryFlaggedDocs(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  field: 'pinnedAt' | 'followUpAt',
  max: number,
): Promise<FirebaseFirestore.QueryDocumentSnapshot[] | null> {
  try {
    const snap = await db.collection('conversations')
      .where('workspaceId', '==', workspaceId)
      .orderBy(field, 'desc')
      .limit(max)
      .get()
    return snap.docs
  }
  catch (e: any) {
    console.warn(`[conversations/list] ${field} 查詢失敗（多半是缺複合索引）:`, String(e?.message || '').slice(0, 300))
    return null
  }
}

/**
 * GET /api/conversations/list
 * Query: page, limit, search, flag（flag=followup 只看待跟進）,
 *        userId（直達單筆，見下）, after（「載入更多」游標＝上一頁最後一筆 doc id）
 * Response: { conversations, total, page, limit, hasMore, truncated }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const query = getQuery(event)
  const searchRaw = String(query.search || '').trim().toLowerCase()
  const flag = String(query.flag || '').trim()
  const { page, limit, offset } = parseAdminListPagination(query, { limit: 30 })
  const afterId = String(query.after || '').trim()

  const db = getDb()

  // ── 直達單筆（監控頁／小幫手「開對話」深連結） ──────────────────────
  // 帶純 LINE userId 或完整 doc id 都收。以前這條路走「search=userId 的整段掃描」——
  // 客人越舊掃越多（最舊要掃完 3,000 條對話＋3,000 份 user），其實照編號讀就是 1 次。
  const directUserId = String(query.userId || '').trim()
  if (directUserId) {
    const docId = lineUserFirestoreDocId(directUserId, workspaceId)
    const snap = await db.collection('conversations').doc(docId).get()
    const empty = { conversations: [], total: 0, page: 1, limit, hasMore: false }
    if (!snap.exists || snap.data()?.workspaceId !== workspaceId) return empty
    const rows = await enrichConversations(db, [snap as FirebaseFirestore.QueryDocumentSnapshot])
    return { conversations: rows, total: rows.length, page: 1, limit, hasMore: false }
  }

  // ── 只看待跟進 ────────────────────────────────────────────────────
  // 標記量小（就是客服自己的待辦），一次撈完在記憶體排，不做分頁；
  // 真的超過上限就把 truncated 帶回去讓畫面明講，不要默默只顯示一部分。
  if (flag === 'followup') {
    const docs = await queryFlaggedDocs(db, workspaceId, 'followUpAt', FOLLOW_UP_LIST_LIMIT + 1)
    if (docs === null) {
      throw createError({ statusCode: 503, statusMessage: '待跟進清單暫時查不到（資料庫索引建立中），請稍後再試' })
    }
    const truncated = docs.length > FOLLOW_UP_LIST_LIMIT
    const rows = (await enrichConversations(db, docs.slice(0, FOLLOW_UP_LIST_LIMIT)))
      .filter(row => matchesSearch(row, searchRaw))
    return {
      conversations: rows,
      total: rows.length,
      page: 1,
      limit,
      hasMore: false,
      truncated,
    }
  }

  const baseRef = db.collection('conversations')
    .where('workspaceId', '==', workspaceId)
    .orderBy('lastMessageAt', 'desc')

  if (!searchRaw) {
    const countSnap = await baseRef.count().get()
    const total = countSnap.data().count

    // 釘選置頂（合併規則與去重原因見 withPinnedFirst）
    const pinnedDocs = await queryFlaggedDocs(db, workspaceId, 'pinnedAt', MAX_PINNED_CONVERSATIONS)
    const pinnedIds = new Set((pinnedDocs ?? []).map(d => d.id))
    const pinnedRows = page === 1 && pinnedDocs?.length
      ? await enrichConversations(db, pinnedDocs)
      : []

    let ref = baseRef as FirebaseFirestore.Query
    if (afterId) {
      // 「載入更多」的游標：offset 對跳過的每一筆都收讀取費（第 N 頁付 30×(N-1) 筆），
      // 游標只多花 1 次讀取拿錨點文件
      const cursorSnap = await db.collection('conversations').doc(afterId).get()
      if (cursorSnap.exists && cursorSnap.data()?.workspaceId === workspaceId) ref = ref.startAfter(cursorSnap)
      else if (offset > 0) ref = ref.offset(offset) // 游標失效退回 offset，寧可貴不要空頁
    }
    else if (offset > 0) {
      ref = ref.offset(offset) // 相容沒帶游標的舊呼叫
    }
    const snap = await ref.limit(limit).get()
    const rows = await enrichConversations(db, snap.docs)
    // hasMore 要看「原始這一頁抓了幾筆」，不能用扣掉釘選後的筆數，否則會提早判定沒有下一頁
    const loaded = offset + snap.docs.length

    return {
      conversations: withPinnedFirst(pinnedRows, rows, pinnedIds),
      total,
      page,
      limit,
      hasMore: loaded < total,
    }
  }

  // ── 搜尋 ──────────────────────────────────────────────────────────
  // 反過來掃 users：搜尋比的名字就存在 users 文件上。舊版掃 conversations 邊掃邊
  // join users，名字命中少的搜尋每次都掃滿 3,000 筆＝約 130 趟循序往返（體感十幾秒）
  // ＋近六千次計費讀取；掃 users 一趟查詢撈完全部名字，命中的才照編號去讀對話。
  // 搜尋時不做釘選置頂：這時清單是「搜尋結果」，照時間序給就好。
  const uSnap = await db.collection('users')
    .where('workspaceId', '==', workspaceId)
    .select('displayName', 'pictureUrl', 'isBlocked')
    .get()

  const matchedUsers = uSnap.docs.filter((d) => {
    const name = String(d.data().displayName || '').trim().toLowerCase()
    if (name.includes(searchRaw)) return true
    // 只比 LINE userId 本體、不含 workspace 前綴：連前綴一起比的話，
    // 搜到跟 workspaceId 撞字的字母會整批命中
    return lineUserIdFromFirestoreDocId(d.id, workspaceId).toLowerCase().includes(searchRaw)
  })

  const truncated = matchedUsers.length > MAX_SEARCH_MATCHES
  const capped = matchedUsers.slice(0, MAX_SEARCH_MATCHES)
  const userDataById = new Map(capped.map(d => [d.id, d.data()] as const))

  // 有 user 不一定有對話（加好友沒開口就沒有 conversations 文件），照編號讀、不存在的略過
  const convSnaps = capped.length
    ? await db.getAll(...capped.map(d => db.collection('conversations').doc(d.id)))
    : []

  const matched: ConvRow[] = []
  for (const snap of convSnaps) {
    if (!snap.exists) continue
    const data = snap.data()!
    if (data.workspaceId !== workspaceId) continue
    const user = userDataById.get(snap.id) ?? {}
    const flags = readConversationFlags(data)
    matched.push({
      userId: snap.id,
      displayName: String(user.displayName || '').trim() || DISPLAY_FALLBACK,
      pictureUrl: String(user.pictureUrl || '').trim(),
      lastMessage: data.lastMessage ?? '',
      lastDirection: data.lastDirection ?? 'incoming',
      lastMessageAt: data.lastMessageAt ?? null,
      customerLastAt: data.lastInboundMessageAt ?? null,
      isBlocked: user.isBlocked === true,
      pinned: flags.pinned,
      followUp: flags.followUp,
      assignee: readConversationAssignee(data),
    })
  }
  matched.sort((a, b) => timestampMillis(b.lastMessageAt) - timestampMillis(a.lastMessageAt))

  return {
    conversations: matched.slice(offset, offset + limit),
    total: matched.length,
    page,
    limit,
    hasMore: matched.length > offset + limit,
    truncated,
  }
})
