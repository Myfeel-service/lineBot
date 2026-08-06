import { getDb } from '~~/server/utils/firebase'
import type { ConversationEventType, ModuleType } from '~~/shared/types/conversation-stats'
import {
  MODULE_TYPE_LABELS,
  STATUS_LABELS,
} from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { resolveMessageSender, type MessageSender } from '~~/shared/message-sender'

type TimelineItemType = 'message' | 'event' | 'broadcast'

/** 一場會話最多顯示幾顆群發泡泡（時間軸不是推播報表，看到有發過就夠） */
const BROADCAST_JOIN_LIMIT = 20

interface TimelineItem {
  id: string
  type: TimelineItemType
  timestamp: any
  // message fields
  direction?: 'incoming' | 'outgoing'
  /** 出站訊息：對方在 lastPeerActivityAt 之前有互動／來訊時推定已讀（非 LINE 內建已讀） */
  readByPeer?: boolean
  text?: string
  messageType?: string
  payload?: unknown
  /** 客人傳的圖，AI 讀出來的一句說明（與對話頁同一個欄位，兩邊顯示要一致） */
  mediaDescription?: string
  /** 這則是誰回的（與對話頁同一套判定，見 shared/message-sender.ts）；null＝舊訊息，不掛標籤 */
  sender?: MessageSender | null
  senderName?: string
  /** 這則是哪一次 AI 回合送出的（見 AiTurnDoc）；空＝舊訊息，不給「為什麼這樣答」入口 */
  aiTurnId?: string
  // event fields
  eventType?: ConversationEventType
  moduleType?: ModuleType
  moduleId?: string
  label?: string
  // broadcast fields（讀取時才拼進來，見 loadBroadcastItems）
  broadcastId?: string
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
  openedAt: Date,
  closedAt: Date | null,
): Promise<TimelineItem[]> {
  try {
    let ref = db.collection('broadcasts')
      .where('workspaceId', '==', workspaceId)
      .where('audienceSnapshot.resolvedUserIds', 'array-contains', userDocId)
      .where('completedAt', '>=', openedAt) as FirebaseFirestore.Query
    if (closedAt) ref = ref.where('completedAt', '<=', closedAt)

    const snap = await ref.limit(BROADCAST_JOIN_LIMIT).get()
    return snap.docs
      // 全員送失敗的推播沒人收到，不該出現在客人的時間軸
      .filter(d => Number(d.data().sentCount ?? 0) > 0)
      .map(d => ({
        id: `bc-${d.id}`,
        type: 'broadcast' as TimelineItemType,
        timestamp: d.data().completedAt,
        label: `已發送群發：${String(d.data().name || '未命名推播').slice(0, 40)}`,
        broadcastId: d.id,
      }))
  }
  catch (e: any) {
    console.warn('[timeline] broadcast join skipped:', String(e?.message ?? e).slice(0, 200))
    return []
  }
}

/**
 * 訊息窗口往前多看的緩衝。
 *
 * 為什麼需要：客人訊息的時間戳是 **LINE 收到的時間**，而舊資料的 session.openedAt 是
 * **我們處理到的時間**，後者一定晚幾百毫秒（網路 + 冷啟動）。用 `timestamp >= openedAt`
 * 取窗口的話，「開啟這場會話的那句話」天生就會被切掉——客服點進任何一場新會話，
 * 都看不到客人最初說了什麼。新資料已改用來訊時間當 openedAt（見 ensureConversationSession），
 * 這個緩衝是給既有資料的（openedAt 已經寫死了，改不了）。
 *
 * 60 秒遠大於實際落差（毫秒級），又短到不會撈進不相關的東西；
 * 而且下面還會用「上一場的結束時間」把窗口夾住，人工結束會話後客人馬上再傳訊也不會混場。
 */
const WINDOW_LOOKBACK_MS = 60_000

/**
 * 找出這位客人「上一場」會話的結束時間，當作本場窗口的硬下界。
 *
 * 只用 userId 等值查詢（不加 orderBy）→ 不需要複合索引；同一位客人的會話數量很少。
 * 查不到／查詢失敗就回 0（等於不夾），寧可多看 60 秒也不要讓整條時間軸掛掉。
 */
async function previousSessionEndMs(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  lineUserId: string,
  sessionId: string,
  openedMs: number,
): Promise<number> {
  try {
    const snap = await db.collection('conversationSessions')
      .where('userId', '==', lineUserId)
      .where('workspaceId', '==', workspaceId)
      .get()
    let latest = 0
    for (const d of snap.docs) {
      if (d.id === sessionId) continue
      const data = d.data()
      const prevOpened = toMillis(data.openedAt)
      if (!prevOpened || prevOpened >= openedMs) continue
      // 上一場的邊界取「結束時間」，沒有結束時間（異常殘留）就用它的最後活動時間
      const end = toMillis(data.closedAt) || toMillis(data.lastActivityAt)
      if (end > latest && end <= openedMs) latest = end
    }
    return latest
  }
  catch (e: any) {
    console.warn('[timeline] previous session lookup failed:', String(e?.message ?? e).slice(0, 160))
    return 0
  }
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
     * （messageType='customer_action'，見 shared/customer-action.ts）——那個在對話頁也看得到。
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

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const sessionId = getRouterParam(event, 'sessionId')
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: 'sessionId required' })

  const db = getDb()
  const sessionSnap = await db.collection('conversationSessions').doc(sessionId).get()
  if (!sessionSnap.exists || sessionSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此會話' })
  }

  const session = sessionSnap.data()!
  const userId = session.userId as string
  const lineUserId = lineUserIdFromFirestoreDocId(userId)
  const convDocId = lineUserFirestoreDocId(lineUserId, workspaceId)

  const convSnap = await db.collection('conversations').doc(convDocId).get()
  const peerMs = convSnap.exists ? toMillis(convSnap.data()?.lastPeerActivityAt) : 0

  // Fetch events for this session (avoid composite index: sessionId + orderBy timestamp)
  const eventsSnap = await db.collection('conversationEvents')
    .where('sessionId', '==', sessionId)
    .get()

  // Fetch messages in the session time window
  const openedAt = session.openedAt?.toDate?.() ?? new Date(0)
  const closedAt = session.closedAt?.toDate?.() ?? new Date()
  const openMs = toMillis(openedAt)
  const closeMs = session.closedAt ? toMillis(closedAt) : Number.POSITIVE_INFINITY

  // 窗口起點：openedAt 往前 60 秒，但不得跨進上一場（見 WINDOW_LOOKBACK_MS）
  const prevEndMs = openMs ? await previousSessionEndMs(db, workspaceId, lineUserId, sessionId, openMs) : 0
  const windowStartMs = openMs
    ? Math.max(openMs - WINDOW_LOOKBACK_MS, prevEndMs > 0 ? prevEndMs + 1 : 0)
    : openMs
  const windowStart = new Date(windowStartMs)

  const msgCol = db.collection('conversations').doc(convDocId).collection('messages')

  let messageDocs: FirebaseFirestore.QueryDocumentSnapshot[] = []
  try {
    let msgsRef = msgCol
      .where('timestamp', '>=', windowStart)
      .orderBy('timestamp', 'asc') as FirebaseFirestore.Query

    if (session.closedAt) {
      msgsRef = msgCol
        .where('timestamp', '>=', windowStart)
        .where('timestamp', '<=', closedAt)
        .orderBy('timestamp', 'asc')
    }

    messageDocs = (await msgsRef.limit(500).get()).docs
  }
  catch (e: any) {
    const msg = String(e?.message || '')
    const code = Number(e?.code || 0)
    const isMissingIndex = code === 9 && /requires an index/i.test(msg)
    if (!isMissingIndex) throw e
    console.warn('[timeline] message window query missing index, using fallback:', msg.slice(0, 280))
    const snap = await msgCol.orderBy('timestamp', 'desc').limit(500).get()
    messageDocs = snap.docs
      .filter((d) => {
        const t = toMillis(d.data().timestamp)
        return t >= windowStartMs && t <= closeMs
      })
      .reverse()
  }

  const items: TimelineItem[] = []

  for (const d of eventsSnap.docs) {
    const e = d.data()
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

  // 群發推播（讀取時才拼，零寫入）。起點與訊息同一個窗口——不然「推播送出後客人才開口」
  // 開的那場會話，會看到客人的話卻看不到他在回什麼
  items.push(...await loadBroadcastItems(
    db,
    workspaceId,
    convDocId,
    windowStart,
    session.closedAt ? closedAt : null,
  ))

  for (const d of messageDocs) {
    const m = d.data()
    const direction = m.direction as 'incoming' | 'outgoing' | undefined
    const msgMs = toMillis(m.timestamp)
    const readByPeer = direction === 'outgoing' && peerMs > 0 && msgMs > 0 && msgMs <= peerMs
    items.push({
      id: d.id,
      type: 'message',
      timestamp: m.timestamp,
      direction,
      readByPeer,
      text: m.text,
      messageType: m.messageType,
      payload: m.payload,
      mediaDescription: m.mediaDescription ?? '',
      sender: resolveMessageSender({ direction, sender: m.sender, aiGenerated: m.aiGenerated }),
      senderName: m.senderName ?? '',
      aiTurnId: m.aiTurnId ?? '',
    })
  }

  // Sort by timestamp
  items.sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))

  return {
    sessionId,
    userId,
    status: session.status,
    statusLabel: STATUS_LABELS[session.status as keyof typeof STATUS_LABELS] ?? session.status,
    initialHandler: session.initialHandler,
    hasHandoff: session.hasHandoff,
    openedAt: session.openedAt,
    closedAt: session.closedAt,
    items,
  }
})
