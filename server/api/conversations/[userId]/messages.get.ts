import { getDb } from '~~/server/utils/firebase'
import type { ConversationStatus } from '~~/shared/types/conversation-stats'
import { STATUS_LABELS } from '~~/shared/types/conversation-stats'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { resolveMessageSender } from '~~/shared/message-sender'

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

  const userId = getRouterParam(event, 'userId')
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })

  const db = getDb()

  // Verify the conversation belongs to this workspace
  const convDocId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userId, workspaceId), workspaceId)
  const convRef = db.collection('conversations').doc(convDocId)
  const convSnap = await convRef.get()
  if (!convSnap.exists || convSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此對話' })
  }
  const snap = await convRef
    .collection('messages')
    .orderBy('timestamp', 'desc')
    .limit(200)
    .get()

  const peerMs = toMillis(convSnap.data()?.lastPeerActivityAt)

  // 抓最新 200 筆，再反轉成舊->新，讓前端顯示維持由上到下的時間序
  const messages = snap.docs.map((d) => {
    const data = d.data()
    const direction = data.direction as 'incoming' | 'outgoing'
    const msgMs = toMillis(data.timestamp)
    const readByPeer = direction === 'outgoing' && peerMs > 0 && msgMs > 0 && msgMs <= peerMs
    return {
      id: d.id,
      direction,
      text: data.text as string,
      messageType: (data.messageType as string | undefined) ?? 'text',
      payload: data.payload ?? null,
      timestamp: data.timestamp ?? null,
      readByPeer,
      /** 客人傳的圖，AI 讀出來的一句說明（沒讀到或 AI 未啟用就是空字串） */
      mediaDescription: (data.mediaDescription as string | undefined) ?? '',
      /** 這則是誰回的：真人 / AI / 機器人 / 系統。null＝這功能上線前的舊訊息，前端不掛標籤 */
      sender: resolveMessageSender({ direction, sender: data.sender, aiGenerated: data.aiGenerated }),
      senderName: (data.senderName as string | undefined) ?? '',
    }
  }).reverse()

  const convData = convSnap.data()
  const currentSessionId = convData?.currentSessionId as string | undefined | null
  let activeSession: {
    sessionId: string
    status: ConversationStatus
    statusLabel: string
  } | null = null

  if (currentSessionId) {
    const sSnap = await db.collection('conversationSessions').doc(currentSessionId).get()
    if (sSnap.exists) {
      const st = sSnap.data()?.status as ConversationStatus
      activeSession = {
        sessionId: currentSessionId,
        status: st,
        statusLabel: STATUS_LABELS[st] ?? String(st),
      }
    }
  }

  return { messages, activeSession }
})
