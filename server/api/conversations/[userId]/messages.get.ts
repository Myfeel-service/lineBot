import { getDb } from '~~/server/utils/firebase'
import type { ConversationEventType, ConversationStatus, ModuleType } from '~~/shared/types/conversation-stats'
import { MODULE_TYPE_LABELS, STATUS_LABELS } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { resolveMessageSender, type MessageSender } from '~~/shared/message-sender'

/**
 * GET /api/conversations/:userId/messages
 *
 * 一位客人的**完整對話時間軸**，分段讀：訊息 + 系統事件（新會話開始／轉真人／已結束…）
 * + 群發標記全部混在同一條流裡。
 *
 * 為什麼只有這一支：以前「全部」分頁讀這裡（整條對話、但沒有事件行），會話分頁另外讀
 * sessions/:id/timeline（有事件行、但訊息**只有那一場**）。同一位客人從不同分頁點進去
 * 看到的東西不一樣，而且從待真人／已結束點進去時看不到之前談過什麼——客服要往回翻，
 * 只能切回「全部」再找一次。現在五個分頁都走這一支，看到的永遠是同一條完整對話。
 *
 * 分段讀（而不是一次撈完）：預設只給最新 DEFAULT_PAGE_SIZE 則，往上滑再帶 beforeId
 * 讀更早的一段（見前端 loadOlderTimeline）。半年的對話一次撈出來，第一次開啟要等、
 * 而且九成九的內容沒有人會看。
 *
 * Query：
 *   · limit     一段幾則（上限 MAX_PAGE_SIZE）
 *   · beforeId  往上讀：比這一則更早的一段（游標是訊息 id，不是時間戳——同一毫秒
 *               連送兩則時用時間戳當游標會漏或重複）
 *   · afterId   往下讀：比這一則更晚的一段
 *   · sessionId 從會話分頁點進來的那一場。那場**已結束**時，第一段就從那場的尾巴
 *               往回讀（否則客服點三天前那場，畫面停在今天的訊息上，等於沒點）。
 */

/** 一段幾則。40 則約是一個畫面多一點，往上滑就接著讀下一段 */
const DEFAULT_PAGE_SIZE = 40
const MAX_PAGE_SIZE = 200

/** 一段時間軸最多帶幾顆群發泡泡（時間軸不是推播報表，看到有發過就夠） */
const BROADCAST_JOIN_LIMIT = 20

type TimelineItemType = 'message' | 'event' | 'broadcast'

interface TimelineItem {
  id: string
  type: TimelineItemType
  timestamp: unknown
  // ── 訊息 ──
  direction?: 'incoming' | 'outgoing'
  /** 出站訊息：對方在 lastPeerActivityAt 之前有互動／來訊時推定已讀（非 LINE 內建已讀） */
  readByPeer?: boolean
  text?: string
  messageType?: string
  payload?: unknown
  /** 客人傳的圖，AI 讀出來的一句說明（沒讀到或 AI 未啟用就是空字串） */
  mediaDescription?: string
  /** 這則是誰回的：真人 / AI / 機器人 / 系統。null＝這功能上線前的舊訊息，前端不掛標籤 */
  sender?: MessageSender | null
  senderName?: string
  /**
   * 這則是哪一次 AI 回合送出的（見 AiTurnDoc）。有值才給「為什麼這樣答」的入口——
   * 空字串＝這功能上線前的舊訊息，刻意不用時間去猜是哪一回合（猜錯會讓客服對著錯的
   * 那一題按「答錯」，比沒有更糟；同 sender 標籤的「不猜」原則）。
   */
  aiTurnId?: string
  // ── 事件 ──
  eventType?: ConversationEventType
  moduleType?: ModuleType
  moduleId?: string
  label?: string
  // ── 群發（讀取時才拼進來，見 loadBroadcastItems）──
  broadcastId?: string
}

/** 一場會話：給工具列、AI 脈絡卡窗口，也用來界定事件要撈哪幾場 */
interface SessionMeta {
  sessionId: string
  status: ConversationStatus
  statusLabel: string
  openedAtMs: number
  closedAtMs: number
}

/**
 * 這一段時間軸的時間範圍。訊息由游標決定，事件與群發只能靠時間對進來，
 * 所以邊界的開閉要精確——否則同一顆「會話已結束」會在相鄰兩段各出現一次。
 *
 * 上界用「游標那一則的時間（不含）」而不是「這一段最新一則的時間」：往上翻時，
 * 這一段最新一則與上一段最舊一則之間有空隙，用後者會把落在空隙裡的事件整段吃掉。
 */
interface TimeWindow {
  fromMs: number
  toMs: number
  fromExclusive: boolean
  toExclusive: boolean
}

function toMillis(raw: unknown): number {
  if (raw == null) return 0
  if (typeof raw === 'object' && raw !== null && 'toMillis' in raw && typeof (raw as { toMillis: () => number }).toMillis === 'function') {
    return (raw as { toMillis: () => number }).toMillis()
  }
  if (typeof raw === 'object' && raw !== null && 'toDate' in raw && typeof (raw as { toDate: () => Date }).toDate === 'function') {
    return (raw as { toDate: () => Date }).toDate().getTime()
  }
  if (raw instanceof Date) return raw.getTime()
  const t = new Date(String(raw)).getTime()
  return Number.isFinite(t) ? t : 0
}

function inWindow(ms: number, w: TimeWindow): boolean {
  if (ms <= 0) return false
  if (w.fromExclusive ? ms <= w.fromMs : ms < w.fromMs) return false
  if (w.toExclusive ? ms >= w.toMs : ms > w.toMs) return false
  return true
}

function eventLabel(eventType: ConversationEventType, moduleType?: ModuleType, moduleId?: string): string {
  if (eventType === 'conversation_opened') return '新會話開始'
  if (eventType === 'conversation_closed') return '會話已結束'
  if (eventType === 'handoff_request') return '請求轉接真人'
  if (eventType === 'human_first_reply') return '真人客服首次回覆'
  if (eventType === 'returned_to_bot') return '已交還機器人'
  if (eventType === 'postback_no_reply') {
    /**
     * 只會出現在舊資料上：現在「客人按了按鈕但沒回覆」改記成一筆客人動作紀錄
     * （messageType='customer_action'，見 shared/customer-action.ts）——那個在對話流裡就看得到。
     * 文案刻意與那邊一致，同一件事在兩處不該有兩種說法。
     */
    return moduleId
      ? '客人點了按鈕，但指向的內容已失效（沒有回覆送出）'
      : '客人點了按鈕，但沒有對應的回覆內容（沒有回覆送出）'
  }
  if (eventType === 'entered_module') {
    const label = moduleType ? MODULE_TYPE_LABELS[moduleType] : '模組'
    return `進入：${label}`
  }
  return eventType
}

/**
 * 這位客人在這個 workspace 的所有會話。
 *
 * 兩個等值條件（userId + workspaceId）不需要複合索引，但真的撞到索引錯誤時退回只查
 * userId、workspace 在記憶體裡濾——同一位客人的會話數量很少（一天最多一場）。
 * 整支失敗就回空陣列：事件行不顯示，訊息照常，不讓一條輔助查詢把整個對話頁弄掛。
 */
async function loadUserSessions(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  lineUserId: string,
): Promise<SessionMeta[]> {
  const toMeta = (d: FirebaseFirestore.QueryDocumentSnapshot): SessionMeta => {
    const data = d.data()
    const status = data.status as ConversationStatus
    return {
      sessionId: d.id,
      status,
      statusLabel: STATUS_LABELS[status] ?? String(status),
      openedAtMs: toMillis(data.openedAt),
      closedAtMs: toMillis(data.closedAt),
    }
  }
  try {
    const snap = await db.collection('conversationSessions')
      .where('userId', '==', lineUserId)
      .where('workspaceId', '==', workspaceId)
      .get()
    return snap.docs.map(toMeta)
  }
  catch (e: unknown) {
    console.warn('[timeline] session lookup fell back to userId-only:', String((e as Error)?.message ?? e).slice(0, 160))
    try {
      const snap = await db.collection('conversationSessions')
        .where('userId', '==', lineUserId)
        .get()
      return snap.docs.filter(d => d.data().workspaceId === workspaceId).map(toMeta)
    }
    catch (e2: unknown) {
      console.warn('[timeline] session lookup failed:', String((e2 as Error)?.message ?? e2).slice(0, 160))
      return []
    }
  }
}

/** 單獨讀一場會話（驗過 workspace）；不存在或不是這個 workspace 的就回 null */
async function readSessionMeta(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  sessionId: string,
): Promise<SessionMeta | null> {
  const snap = await db.collection('conversationSessions').doc(sessionId).get()
  if (!snap.exists || snap.data()?.workspaceId !== workspaceId) return null
  const data = snap.data()!
  const status = data.status as ConversationStatus
  return {
    sessionId,
    status,
    statusLabel: STATUS_LABELS[status] ?? String(status),
    openedAtMs: toMillis(data.openedAt),
    closedAtMs: toMillis(data.closedAt),
  }
}

/**
 * 這一段時間範圍裡的系統事件。
 *
 * 用 sessionId 撈（不是 userId）：conversationEvents 沒有存 workspaceId，用 userId 查會
 * 跨 workspace（同一個 LINE Provider 下的兩個 OA，同一位客人的 userId 是同一組），
 * 而且會把這位客人半年來的每一筆事件都讀出來。先用會話的時間範圍挑出「這一段可能碰到的
 * 那幾場」，通常只有一到三場，`in` 一次就撈完。
 */
async function loadEventItems(
  db: FirebaseFirestore.Firestore,
  sessions: SessionMeta[],
  w: TimeWindow,
): Promise<TimelineItem[]> {
  const overlapping = sessions.filter((s) => {
    const start = s.openedAtMs || 0
    const end = s.closedAtMs || Number.POSITIVE_INFINITY
    return start <= w.toMs && end >= w.fromMs
  })
  if (!overlapping.length) return []

  const items: TimelineItem[] = []
  try {
    for (let i = 0; i < overlapping.length; i += 30) {
      const ids = overlapping.slice(i, i + 30).map(s => s.sessionId)
      const snap = await db.collection('conversationEvents')
        .where('sessionId', 'in', ids)
        .get()
      for (const d of snap.docs) {
        const e = d.data()
        if (!inWindow(toMillis(e.timestamp), w)) continue
        items.push({
          id: d.id,
          type: 'event',
          timestamp: e.timestamp,
          eventType: e.eventType,
          moduleType: e.moduleType,
          moduleId: e.moduleId,
          label: eventLabel(e.eventType, e.moduleType, e.moduleId),
        })
      }
    }
  }
  catch (e: unknown) {
    console.warn('[timeline] event lookup skipped:', String((e as Error)?.message ?? e).slice(0, 200))
    return []
  }
  return items
}

/**
 * 群發推播：讀取時才拼進時間軸，**不逐筆寫入對話紀錄**。
 *
 * 為什麼不寫：一次三千人的群發就是三千筆重複內容，而且寫成 outgoing 訊息會把
 * 三千個人的 lastMessageAt 同時推到現在——整個「全部」收件匣排序會被洗掉一次，
 * 「已讀」推定也跟著失準。收件人名單本來就完整存在 broadcasts.audienceSnapshot
 * .resolvedUserIds，直接反查即可，零額外寫入、內容只存一份。
 *
 * 缺索引或查詢失敗時回空陣列：群發泡泡不顯示，其餘時間軸照常，不讓整頁掛掉。
 * 規模上限：收件人名單是單一文件內的陣列，Firestore 單文件 1MB，約兩萬多人會頂到
 * （這個限制在寫入端本來就存在，不是這裡帶來的）。
 */
async function loadBroadcastItems(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  userDocId: string,
  w: TimeWindow,
): Promise<TimelineItem[]> {
  try {
    let ref = db.collection('broadcasts')
      .where('workspaceId', '==', workspaceId)
      .where('audienceSnapshot.resolvedUserIds', 'array-contains', userDocId)
      .where('completedAt', '>=', new Date(Math.max(w.fromMs, 0))) as FirebaseFirestore.Query
    if (Number.isFinite(w.toMs)) ref = ref.where('completedAt', '<=', new Date(w.toMs))

    const snap = await ref.limit(BROADCAST_JOIN_LIMIT).get()
    return snap.docs
      // 全員送失敗的推播沒人收到，不該出現在客人的時間軸
      .filter(d => Number(d.data().sentCount ?? 0) > 0)
      .filter(d => inWindow(toMillis(d.data().completedAt), w))
      .map(d => ({
        id: `bc-${d.id}`,
        type: 'broadcast' as TimelineItemType,
        timestamp: d.data().completedAt,
        label: `已發送群發：${String(d.data().name || '未命名推播').slice(0, 40)}`,
        broadcastId: d.id,
      }))
  }
  catch (e: unknown) {
    console.warn('[timeline] broadcast join skipped:', String((e as Error)?.message ?? e).slice(0, 200))
    return []
  }
}

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const routeUserId = getRouterParam(event, 'userId')
  if (!routeUserId) throw createError({ statusCode: 400, statusMessage: 'userId required' })

  const query = getQuery(event)
  const rawLimit = Number(query.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE
  const beforeId = String(query.beforeId || '').trim()
  const afterId = String(query.afterId || '').trim()
  const anchorSessionId = String(query.sessionId || '').trim()

  const db = getDb()
  const lineUserId = lineUserIdFromFirestoreDocId(routeUserId, workspaceId)
  const convDocId = lineUserFirestoreDocId(lineUserId, workspaceId)
  const convRef = db.collection('conversations').doc(convDocId)
  const convSnap = await convRef.get()
  if (!convSnap.exists || convSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此對話' })
  }
  const convData = convSnap.data() ?? {}
  const peerMs = toMillis(convData.lastPeerActivityAt)
  const msgCol = convRef.collection('messages')

  const sessions = await loadUserSessions(db, workspaceId, lineUserId)
  const sessionById = new Map(sessions.map(s => [s.sessionId, s]))

  /** 從會話分頁點進來的那一場（撈不到就直接讀那份文件，順便驗 workspace） */
  let anchorSession: SessionMeta | null = anchorSessionId ? sessionById.get(anchorSessionId) ?? null : null
  if (anchorSessionId && !anchorSession) {
    anchorSession = await readSessionMeta(db, workspaceId, anchorSessionId)
  }

  const currentSessionId = String(convData.currentSessionId ?? '')
  let activeSession = currentSessionId ? sessionById.get(currentSessionId) ?? null : null
  // 會話清單那支查詢退場時（見 loadUserSessions）也要撐得住：工具列上的「結束會話」
  // 不該因為一條輔助查詢失敗就整組消失
  if (currentSessionId && !activeSession) {
    activeSession = await readSessionMeta(db, workspaceId, currentSessionId)
  }

  /**
   * 這一段從哪裡開始讀。
   *
   * 錨定只在「第一段」有意義（帶了游標就是使用者已經在翻了）：點進一場**已結束**的會話時，
   * 從那場的結束時間往回讀，畫面第一眼就是他點的那一場；還在進行中的那場結束時間就是現在，
   * 等於直接讀最新一段，不必特別處理。
   */
  const anchorCloseMs = anchorSession && !beforeId && !afterId ? anchorSession.closedAtMs : 0

  let pageDocs: FirebaseFirestore.QueryDocumentSnapshot[] = []
  let hasOlder = false
  let hasNewer = false
  const w: TimeWindow = {
    fromMs: 0,
    toMs: Number.POSITIVE_INFINITY,
    fromExclusive: false,
    toExclusive: false,
  }

  if (afterId) {
    const cursor = await msgCol.doc(afterId).get()
    // 游標那則已被保留期清掉（見 cleanup.post.ts）＝就停在這裡，不要偷偷跳到別的地方
    if (!cursor.exists) {
      return { items: [], hasOlder: false, hasNewer: false, limit, activeSession, session: anchorSession }
    }
    const docs = (await msgCol.orderBy('timestamp', 'asc').startAfter(cursor).limit(limit + 1).get()).docs
    hasNewer = docs.length > limit
    pageDocs = docs.slice(0, limit)
    hasOlder = true
    w.fromMs = toMillis(cursor.data()?.timestamp)
    w.fromExclusive = true
    if (hasNewer && pageDocs.length) {
      w.toMs = toMillis(pageDocs[pageDocs.length - 1]!.data().timestamp)
    }
  }
  else {
    let ref = msgCol.orderBy('timestamp', 'desc') as FirebaseFirestore.Query
    if (beforeId) {
      const cursor = await msgCol.doc(beforeId).get()
      if (!cursor.exists) {
        return { items: [], hasOlder: false, hasNewer: true, limit, activeSession, session: anchorSession }
      }
      ref = ref.startAfter(cursor)
      hasNewer = true
      w.toMs = toMillis(cursor.data()?.timestamp)
      w.toExclusive = true
    }
    else if (anchorCloseMs > 0) {
      // 上界取結束時間（含）而不是最後一則訊息：「會話已結束」那一行是在最後一則之後才蓋的
      ref = msgCol.where('timestamp', '<=', new Date(anchorCloseMs)).orderBy('timestamp', 'desc')
      w.toMs = anchorCloseMs
    }

    const docs = (await ref.limit(limit + 1).get()).docs
    hasOlder = docs.length > limit
    pageDocs = docs.slice(0, limit).reverse()

    if (anchorCloseMs > 0) {
      // 這場之後還有沒有訊息（＝下面還有沒載入的內容，前端要給一條往下走的路）
      const newest = pageDocs[pageDocs.length - 1]
      const probe = newest
        ? await msgCol.orderBy('timestamp', 'asc').startAfter(newest).limit(1).get()
        : await msgCol.where('timestamp', '>', new Date(anchorCloseMs)).limit(1).get()
      hasNewer = !probe.empty
    }

    /**
     * 下界：還有更早的一段沒讀時，事件只收這一段之內的；已經讀到最早了就不設下界，
     * 好讓「新會話開始」那一行落在第一則訊息之前也看得到。
     *
     * 往下讀（afterId）那條路刻意不套這個：那時下界是「游標那一則的時間」，
     * 換成這一段最舊一則會把兩者之間的事件整段吃掉——「會話已結束」正好落在那裡
     * （客人的最後一句之後才蓋，而下一則訊息可能是幾小時後的事）。
     */
    if (hasOlder && pageDocs.length) {
      w.fromMs = toMillis(pageDocs[0]!.data().timestamp)
      w.fromExclusive = false
    }
  }

  const items: TimelineItem[] = []
  for (const d of pageDocs) {
    const m = d.data()
    const direction = m.direction as 'incoming' | 'outgoing' | undefined
    const msgMs = toMillis(m.timestamp)
    const readByPeer = direction === 'outgoing' && peerMs > 0 && msgMs > 0 && msgMs <= peerMs
    items.push({
      id: d.id,
      type: 'message',
      timestamp: m.timestamp ?? null,
      direction,
      readByPeer,
      text: m.text,
      messageType: (m.messageType as string | undefined) ?? 'text',
      payload: m.payload ?? null,
      mediaDescription: (m.mediaDescription as string | undefined) ?? '',
      sender: resolveMessageSender({ direction, sender: m.sender, aiGenerated: m.aiGenerated }),
      senderName: (m.senderName as string | undefined) ?? '',
      aiTurnId: (m.aiTurnId as string | undefined) ?? '',
    })
  }

  // 空對話（一則訊息都沒有，例如剛加好友就被開場模組記了事件）也要看得到事件行，
  // 所以事件不綁在訊息存在與否上
  items.push(...await loadEventItems(db, sessions, w))
  items.push(...await loadBroadcastItems(db, workspaceId, convDocId, w))

  items.sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))

  return {
    items,
    hasOlder,
    hasNewer,
    limit,
    /** 對話目前進行中的那一場（「全部」分頁的工具列用） */
    activeSession,
    /** ?sessionId= 點進來的那一場（會話分頁工具列 + AI 脈絡卡的時間窗口） */
    session: anchorSession,
  }
})
