import { getDb } from '~~/server/utils/firebase'
import type { ConversationStatus, InitialHandler } from '~~/shared/types/conversation-stats'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { isOpenQueueSession } from '~~/server/utils/conversation-queue'
import { type ConversationManualFlags, readConversationFlags } from '~~/shared/conversation-flags'
import { NO_ASSIGNEE, readConversationAssignee, type ConversationAssignee } from '~~/shared/conversation-assignee'
import { taipeiDayEnd, taipeiDayStart } from '~~/server/utils/taipei-day'

const PAGE_SIZE = 30
const CHUNK = 30
const FALLBACK_MAX_FETCH = 1000
const DISPLAY_FALLBACK = 'LINE 用戶'

function uniqueFirestoreUserIds(rawIds: string[], workspaceId: string): string[] {
  return [...new Set(rawIds.map(uid => lineUserFirestoreDocId(uid, workspaceId)))]
}

/** 一位客人的對話層級資料：人工標記 + 目前進行中的會話 + 最後一則訊息 */
interface ConvSideData {
  flags: ConversationManualFlags
  /** 負責人員也是對話層級的：同一位客人在哪個分頁看都要是同一個人（見 shared/conversation-assignee.ts） */
  assignee: ConversationAssignee
  currentSessionId: string
  lastMessage: string
  lastDirection: 'incoming' | 'outgoing'
  lastMessageAt: unknown
  /** 客人最後一則訊息的時間＝紅點比的那個值（見 shared/conversation-unread.ts） */
  lastInboundMessageAt: unknown
}

/**
 * 這一頁會用到的對話層級資料。
 *
 * 標記（釘選 / 待跟進）存在 `conversations` 文件上，會話列表也要顯示同一份，
 * 不然同一位客人在「全部」有標記、切到「待真人」就不見了。
 * 順手把最後一則訊息帶出來——列表五個分頁的第二行都要它，而這份文件本來就要讀。
 * conversations 與 users 共用同一組 doc id，所以直接沿用已算好的 fsUserIds。
 */
async function fetchConversationSideData(
  db: FirebaseFirestore.Firestore,
  fsUserIds: string[],
): Promise<Record<string, ConvSideData | undefined>> {
  const map: Record<string, ConvSideData | undefined> = {}
  for (let i = 0; i < fsUserIds.length; i += CHUNK) {
    const chunk = fsUserIds.slice(i, i + CHUNK)
    const cSnap = await db.collection('conversations').where('__name__', 'in', chunk).get()
    cSnap.docs.forEach((d) => {
      const data = d.data()
      map[d.id] = {
        flags: readConversationFlags(data),
        assignee: readConversationAssignee(data),
        currentSessionId: String(data.currentSessionId ?? ''),
        lastMessage: String(data.lastMessage ?? ''),
        lastDirection: data.lastDirection === 'outgoing' ? 'outgoing' : 'incoming',
        lastMessageAt: data.lastMessageAt ?? null,
        lastInboundMessageAt: data.lastInboundMessageAt ?? null,
      }
    })
  }
  return map
}

function mapSessionToRow(
  sessionDocId: string,
  s: Record<string, unknown>,
  userMap: Record<string, Record<string, unknown> | undefined>,
  convMap: Record<string, ConvSideData | undefined>,
  workspaceId: string,
) {
  const fsUid = lineUserFirestoreDocId(String(s.userId || ''), workspaceId)
  const user = userMap[fsUid] ?? {}
  const displayName = String(user.displayName || '').trim() || DISPLAY_FALLBACK
  const conv = convMap[fsUid]
  /**
   * 這場會話的最後一則訊息。
   *
   * 進行中那場（= conversations.currentSessionId）直接讀對話層級那份：定義上就是同一則。
   * 已結束的場讀自己身上的快照（關閉當下蓋的，見 sessionClosingPreview）——**不可以**
   * 退回去用對話層級的，那會把後來新會話的訊息標到舊的這場上。
   * 兩個都沒有（快照上線前就結束的舊會話）＝留白，不猜。
   */
  const isCurrent = Boolean(conv?.currentSessionId) && conv!.currentSessionId === sessionDocId
  const lastMessage = isCurrent ? conv!.lastMessage : String(s.lastMessage ?? '')
  const lastDirection = isCurrent
    ? conv!.lastDirection
    : (s.lastDirection === 'outgoing' ? 'outgoing' : 'incoming')
  return {
    sessionId: sessionDocId,
    userId: fsUid,
    displayName,
    pictureUrl: String(user.pictureUrl || '').trim(),
    pinned: conv?.flags.pinned === true,
    followUp: conv?.flags.followUp === true,
    assignee: conv?.assignee ?? NO_ASSIGNEE,
    lastMessage,
    lastDirection,
    /**
     * 未讀紅點專用的時間，**不可以**用 lastActivityAt。
     *
     * lastActivityAt 記的是「這場有沒有動靜」，客人按按鈕進模組、客服接手／交還／結案、
     * 半夜 auto-handback 排程、24 小時過期自動關場……全都會把它往前推（見
     * conversation-session.ts）。但紅點的另一半條件（lastDirection）問的是「最後一則
     * **訊息**是誰送的」——那個只有真的有人講話才會變。兩個條件取自不同來源，就會出現
     * 「客人是最後講話的人」永遠成立、時間卻一直跳 → 已經看完的列反覆變紅：
     * 按完結案自己紅回來、客人按顆按鈕就紅但摘要沒變、排程跑完隔天一整排紅、
     * 客人今天開口連他去年那些已結束的場也一起紅。
     *
     * 所以這裡跟上面兩個欄位拿同一份來源（進行中那場＝對話文件），三個同進同出，
     * 紅點的判斷才對得上，也和「全部」分頁天生一致。
     * 不是進行中的場一律 null＝不亮紅點：客人再開口會開新的一場，
     * 已結束的場不可能還在等我們回。
     */
    unreadAt: isCurrent ? conv!.lastMessageAt ?? null : null,
    /**
     * 客人最後一則訊息的時間＝紅點真正比的那個值（見 shared/conversation-unread.ts）。
     * 與上面 unreadAt 同一份來源、同一個「只給進行中那場」的規則——已結束的場不可能還在
     * 等我們回，客人再開口會開新的一場。上面那個留著當舊資料的退路（2026-08-19 以前的
     * 對話沒有這欄），兩個都給，前端自己挑。
     */
    customerLastAt: isCurrent ? conv!.lastInboundMessageAt ?? null : null,
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
  // 「載入更多」的游標＝上一頁最後一筆的 session doc id（無限捲動一定拿得到；
  // 沒帶就退回 offset 分頁，見下）
  const afterId = String(query.after || '').trim()

  // 日界線取台北時間，與統計端點同修（見 taipei-day.ts）——
  // 否則統計頁點日期鑽進來，清單和 KPI 數的不是同一批對話
  const startDate = taipeiDayStart(query.startDate)
  const endDate = taipeiDayEnd(query.endDate)
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
    const convMap = await fetchConversationSideData(db, fsUserIds)

    const sessions = sliced.map(({ id, data: s }) => mapSessionToRow(id, s, userMap, convMap, workspaceId))

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
    if (isOpenQueue) {
      // 佇列口徑（open 扣掉「加好友出生、客人未開口」）直接下到查詢。
      // 以前用 scanFilteredPage 在記憶體過濾——2026-08-11 實測 1,584 筆 open 全是
      // 未開口的殭屍場，過濾率 0% ＝ 每次載入整批掃完（Firestore 照筆收讀取費），
      // 停在分頁上每 30 秒輪詢再掃一遍，一小時 19 萬次讀取。
      // 下推的前提是「所有 open session 都有 hasInbound 欄位」（等值查詢不匹配缺欄位
      // 的文件）——兩租戶已實測缺欄位數為 0，且建場時一律寫入（conversation-session.ts）。
      // 需要 (workspaceId, status, hasInbound, lastActivityAt DESC) 複合索引；
      // 還沒部署時會 FAILED_PRECONDITION → 走下面的 runFallback（記憶體過濾，語意同一份）。
      ref = ref.where('hasInbound', '==', true)
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

    const countSnap = await ref.count().get()
    const total = countSnap.data().count

    let pageRef = ref
    if (afterId) {
      // 「載入更多」的游標：接在上一頁最後一筆之後。offset 會對**跳過的每一筆**收讀取費
      // （第 N 頁付 30×(N-1) 筆跳過費，捲得越深越貴），游標只多花 1 次讀取拿錨點文件。
      const cursorSnap = await db.collection('conversationSessions').doc(afterId).get()
      if (cursorSnap.exists && cursorSnap.data()?.workspaceId === workspaceId) {
        pageRef = pageRef.startAfter(cursorSnap)
      }
      else if (offset > 0) {
        pageRef = pageRef.offset(offset) // 游標失效（該場被刪）退回 offset，寧可貴不要空頁
      }
    }
    else if (offset > 0) {
      pageRef = pageRef.offset(offset) // 相容沒帶游標的舊呼叫
    }
    const snap = await pageRef.limit(limit).get()
    const docs = snap.docs
    const hasMore = offset + docs.length < total
    const truncated = false

    if (docs.length === 0) return { sessions: [], total, page, limit, hasMore: false, truncated }

    const rawUserIds = docs.map(d => String(d.data().userId || '')).filter(Boolean)
    const fsUserIds = uniqueFirestoreUserIds(rawUserIds, workspaceId)
    const userMap: Record<string, Record<string, unknown> | undefined> = {}
    for (let i = 0; i < fsUserIds.length; i += CHUNK) {
      const chunk = fsUserIds.slice(i, i + CHUNK)
      const uSnap = await db.collection('users').where('__name__', 'in', chunk).get()
      uSnap.docs.forEach(d => { userMap[d.id] = d.data() })
    }
    const convMap = await fetchConversationSideData(db, fsUserIds)

    const sessions = docs.map(d => mapSessionToRow(d.id, d.data(), userMap, convMap, workspaceId))

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
