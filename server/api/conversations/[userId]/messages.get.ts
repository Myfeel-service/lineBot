import { getDb } from '~~/server/utils/firebase'
import type { ConversationEventType, ConversationStatus, ModuleType } from '~~/shared/types/conversation-stats'
import { MODULE_TYPE_LABELS, STATUS_LABELS } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { resolveMessageSender } from '~~/shared/message-sender'
import { parseFirestoreDate } from '~~/shared/firestore-date'
import { customerActionLabel } from '~~/shared/customer-action'
import type { TimelineItem, TimelineItemType, TimelineSessionMeta } from '~~/shared/types/conversation-timeline'

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

/** 回應的形狀定義在 shared/types/conversation-timeline.ts（前後端同一份，見那邊的說明） */
type SessionMeta = TimelineSessionMeta

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

/**
 * Firestore 時間欄位 → 毫秒（讀不出來就 0，代表「沒有時間」）。
 * 轉換規則統一在 shared/firestore-date.ts：這個專案的時間欄位有 Timestamp、
 * `{seconds}`、序列化後的 `{_seconds}`、ISO 字串好幾種樣子，各寫一份遲早會有一份漏掉。
 */
function toMillis(raw: unknown): number {
  return parseFirestoreDate(raw)?.getTime() ?? 0
}

function inWindow(ms: number, w: TimeWindow): boolean {
  if (ms <= 0) return false
  if (w.fromExclusive ? ms <= w.fromMs : ms < w.fromMs) return false
  if (w.toExclusive ? ms >= w.toMs : ms > w.toMs) return false
  return true
}

function eventLabel(
  eventType: ConversationEventType,
  moduleType?: ModuleType,
  moduleId?: string,
  reason?: string,
): string {
  if (eventType === 'conversation_opened') return '新會話開始'
  if (eventType === 'conversation_closed') {
    // 系統看它太久沒動靜幫忙收的，要跟「客服自己按了結束」分開講——
    // 否則客服看到「會話已結束」卻想不起來自己按過，只會以為系統在亂動
    return reason === 'idle_auto' ? '太久沒有動靜，系統自動結束會話' : '會話已結束'
  }
  if (eventType === 'handoff_request') return '請求轉接真人'
  if (eventType === 'human_first_reply') return '真人客服首次回覆'
  if (eventType === 'returned_to_bot') return '已交還機器人'
  if (eventType === 'postback_no_reply') {
    /**
     * 只會出現在舊資料上：現在「客人按了按鈕但沒回覆」改記成一筆客人動作紀錄
     * （messageType='customer_action'，見 shared/customer-action.ts）——那個在對話流裡就看得到。
     * 直接呼叫那邊的文案函式：同一件事在兩處不該有兩種說法，而「兩份字串靠人記得一起改」
     * 遲早會漂走（漂走時也沒有任何測試或編譯器會出聲）。
     */
    return customerActionLabel({ type: 'button_dead', moduleId })
  }
  if (eventType === 'entered_module') {
    const label = moduleType ? MODULE_TYPE_LABELS[moduleType] : '模組'
    return `進入：${label}`
  }
  return eventType
}

/** 會話文件 → 工具列要的那幾個欄位。清單與單筆兩條路都走這裡，欄位才不會各長各的 */
function sessionMetaOf(sessionId: string, data: FirebaseFirestore.DocumentData): SessionMeta {
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
 * 這位客人在這個 workspace 的會話（由新到舊，最多 SESSION_SCAN_LIMIT 場）。
 *
 * 為什麼要有上限：這支查詢每次開對話、每次往上讀一段、每次送完訊息的安靜刷新都會重跑，
 * 而會話文件是**永遠不會被清掉**的（保留期只清訊息，見 cleanup.post.ts）——聊了兩年的
 * 客人等於每一次請求都把七百份會話文件重讀一遍。
 *
 * 為什麼 200 場夠：一天最多一場（見 conversation-session.ts 的 24 小時規則），而訊息只留
 * CONVERSATION_RETENTION_DAYS（180 天），所以客服翻得到的最舊那一則訊息不會早於 180 天前，
 * 需要對照的會話也就落在最近 180 場之內。留兩倍餘裕。
 *
 * 兩個等值條件加上排序需要複合索引（見 firestore.indexes.json）；索引還沒建好時會落到
 * 下面的退路：只查 userId、workspace 在記憶體裡濾（無上限，但至少答案是對的）。
 * 整支失敗就回空陣列：事件行不顯示，訊息照常，不讓一條輔助查詢把整個對話頁弄掛。
 */
const SESSION_SCAN_LIMIT = 200

async function loadUserSessions(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  lineUserId: string,
): Promise<SessionMeta[]> {
  const toMeta = (d: FirebaseFirestore.QueryDocumentSnapshot): SessionMeta => sessionMetaOf(d.id, d.data())
  try {
    const snap = await db.collection('conversationSessions')
      .where('userId', '==', lineUserId)
      .where('workspaceId', '==', workspaceId)
      .orderBy('openedAt', 'desc')
      .limit(SESSION_SCAN_LIMIT)
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

/**
 * 單獨讀一場會話（驗過 workspace **與客人**）；對不上就回 null。
 *
 * ⚠️ 一定要連 userId 一起驗：這支端點是 `/conversations/{那位客人}/messages`，而 sessionId
 * 是從網址帶進來的。只驗 workspace 的話，帶另一位客人的 sessionId 進來會讓工具列顯示**別人
 * 那場**的狀態與起訖時間，還會把這位客人的時間軸錨定在一個不相干的結束時間上（畫面通常
 * 是空的）。這不是權限漏洞——呼叫端本來就看得到同 workspace 的每一段對話——但顯示的東西
 * 是錯的，而且錯得不會有人發現。
 */
async function readSessionMeta(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  lineUserId: string,
  sessionId: string,
): Promise<SessionMeta | null> {
  const snap = await db.collection('conversationSessions').doc(sessionId).get()
  if (!snap.exists) return null
  const data = snap.data()!
  if (data.workspaceId !== workspaceId || data.userId !== lineUserId) return null
  return sessionMetaOf(sessionId, data)
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
          label: eventLabel(e.eventType, e.moduleType, e.moduleId, e.reason),
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

    // ⚠️ 一定要自己指定由新到舊：範圍條件下 Firestore 的隱含排序是「由舊到新」，
    // 直接 limit(20) 會留下最舊的 20 筆、把客人剛收到的那幾封默默丟掉——而那正是
    // 客服在看的東西。（既有索引是 completedAt ASC，方向全部反轉時可沿用同一份。）
    const snap = await ref.orderBy('completedAt', 'desc').limit(BROADCAST_JOIN_LIMIT).get()
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
  // 兩件事互不相干（一份對話文件、一批會話文件），沒有理由排隊等
  const [convSnap, sessions] = await Promise.all([
    convRef.get(),
    loadUserSessions(db, workspaceId, lineUserId),
  ])
  if (!convSnap.exists || convSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此對話' })
  }
  const convData = convSnap.data() ?? {}
  const peerMs = toMillis(convData.lastPeerActivityAt)
  const msgCol = convRef.collection('messages')

  const sessionById = new Map(sessions.map(s => [s.sessionId, s]))

  /** 從會話分頁點進來的那一場（撈不到就直接讀那份文件，順便驗 workspace） */
  let anchorSession: SessionMeta | null = anchorSessionId ? sessionById.get(anchorSessionId) ?? null : null
  if (anchorSessionId && !anchorSession) {
    anchorSession = await readSessionMeta(db, workspaceId, lineUserId, anchorSessionId)
  }

  const currentSessionId = String(convData.currentSessionId ?? '')
  let activeSession = currentSessionId ? sessionById.get(currentSessionId) ?? null : null
  // 會話清單那支查詢退場時（見 loadUserSessions）也要撐得住：工具列上的「結束會話」
  // 不該因為一條輔助查詢失敗就整組消失
  if (currentSessionId && !activeSession) {
    activeSession = await readSessionMeta(db, workspaceId, lineUserId, currentSessionId)
  }

  /**
   * 這一段從哪裡開始讀。
   *
   * 錨定只在「第一段」有意義（帶了游標就是使用者已經在翻了）：點進一場**已結束**的會話時，
   * 從那場的結束時間往回讀，畫面第一眼就是他點的那一場；還在進行中的那場結束時間就是現在，
   * 等於直接讀最新一段，不必特別處理。
   */
  const anchorCloseMs = (anchorSession && !beforeId && !afterId ? anchorSession.closedAtMs : 0) ?? 0

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
      return { items: [], hasOlder: false, hasNewer: false, activeSession, session: anchorSession }
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
        return { items: [], hasOlder: false, hasNewer: true, activeSession, session: anchorSession }
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
    else {
      /**
       * 已經讀到最早的一則了——但下界**不能**就這樣敞開到 epoch。
       *
       * 保留期清掉的只有訊息，會話與事件是永久留著的（見 cleanup.post.ts）。老客人被清到
       * 只剩幾十則訊息時，敞開的下界會把他這輩子的每一筆事件全部撈出來（每 30 場一次
       * `in` 查詢，讀取量跟著長），再整疊蓋在那幾則訊息上面——畫面上是一整片
       * 「新會話開始／會話已結束」，真正的對話被推到看不見的地方。
       *
       * 取「這一則所屬那一場」的開始時間當下界：既留住「新會話開始」那一行（它正好落在
       * 第一則訊息之前，也是當初不設下界的理由），又不會把更早的場次拖進來。
       * 一則訊息都沒有時（例如剛加好友、或這一場的訊息已被清掉）就用點進來的那一場。
       */
      const oldestMs = pageDocs.length ? toMillis(pageDocs[0]!.data().timestamp) : 0
      const owning = oldestMs > 0
        ? sessions
            .filter(s => (s.openedAtMs ?? 0) > 0 && (s.openedAtMs ?? 0) <= oldestMs)
            .sort((a, b) => (b.openedAtMs ?? 0) - (a.openedAtMs ?? 0))[0]
        : anchorSession
      // 對不到任何一場就維持原本的敞開（寧可多幾行，也不要把事件行整段弄不見）
      if (owning?.openedAtMs) {
        w.fromMs = owning.openedAtMs
        w.fromExclusive = false
      }
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
  // 所以事件不綁在訊息存在與否上。兩批查的是不同集合、互不相干 → 一起發，不要一前一後。
  const [eventItems, broadcastItems] = await Promise.all([
    loadEventItems(db, sessions, w),
    loadBroadcastItems(db, workspaceId, convDocId, w),
  ])
  items.push(...eventItems, ...broadcastItems)

  items.sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))

  return {
    items,
    hasOlder,
    hasNewer,
    /** 對話目前進行中的那一場（「全部」分頁的工具列用） */
    activeSession,
    /** ?sessionId= 點進來的那一場（會話分頁工具列 + AI 脈絡卡的時間窗口） */
    session: anchorSession,
  }
})
