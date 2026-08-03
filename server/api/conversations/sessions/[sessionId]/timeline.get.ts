import { getDb } from '~~/server/utils/firebase'
import type { ConversationEventType, ModuleType } from '~~/shared/types/conversation-stats'
import {
  MODULE_TYPE_LABELS,
  STATUS_LABELS,
} from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'

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

function eventLabel(eventType: ConversationEventType, moduleType?: ModuleType): string {
  if (eventType === 'conversation_opened') return '新會話開始'
  if (eventType === 'conversation_closed') return '會話已結束'
  if (eventType === 'handoff_request') return '請求轉接真人'
  if (eventType === 'human_first_reply') return '真人客服首次回覆'
  if (eventType === 'returned_to_bot') return '已交還機器人'
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

  const msgCol = db.collection('conversations').doc(convDocId).collection('messages')

  let messageDocs: FirebaseFirestore.QueryDocumentSnapshot[] = []
  try {
    let msgsRef = msgCol
      .where('timestamp', '>=', openedAt)
      .orderBy('timestamp', 'asc') as FirebaseFirestore.Query

    if (session.closedAt) {
      msgsRef = msgCol
        .where('timestamp', '>=', openedAt)
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
        return t >= openMs && t <= closeMs
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
      label: eventLabel(e.eventType, e.moduleType),
    })
  }

  // 群發推播（讀取時才拼，零寫入）
  items.push(...await loadBroadcastItems(
    db,
    workspaceId,
    convDocId,
    openedAt,
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
