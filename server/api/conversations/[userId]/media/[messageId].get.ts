import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { lineUserFirestoreDocId, lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'
import { isMediaMessageType, resolveConversationMediaUrl } from '~~/server/utils/conversation-media'

/**
 * GET /api/conversations/:userId/media/:messageId
 *
 * 取客人傳來的圖／影／音／檔的可顯示網址。`messageId` 是 Firestore 訊息文件 id
 * （訊息列表 / 時間軸回傳的 `id`），不是 LINE messageId——後者藏在文件的 payload 裡，
 * 由後端自己取，前端不需要（也不該）知道怎麼跟 LINE 對應。
 *
 * 回傳 state：
 *   ready      → url 可直接放進 <img>/<video>（Storage 短效簽名網址）
 *   expired    → LINE 已刪除原始檔，永久取不回來
 *   not_ready  → 影片還在轉檔，稍後再試
 *   too_large  → 超過單檔上限，不做存檔
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')

  const userId = getRouterParam(event, 'userId')
  const messageDocId = getRouterParam(event, 'messageId')
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })
  if (!messageDocId) throw createError({ statusCode: 400, statusMessage: 'messageId required' })

  const db = getDb()
  const convDocId = lineUserFirestoreDocId(lineUserIdFromFirestoreDocId(userId, workspaceId), workspaceId)
  const convRef = db.collection('conversations').doc(convDocId)
  const convSnap = await convRef.get()
  if (!convSnap.exists || convSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此對話' })
  }

  const msgSnap = await convRef.collection('messages').doc(messageDocId).get()
  if (!msgSnap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此訊息' })

  const data = msgSnap.data() ?? {}
  const payload = (data.payload ?? {}) as Record<string, unknown>
  const messageType = String(payload.type || data.messageType || '')
  if (!isMediaMessageType(messageType)) {
    throw createError({ statusCode: 400, statusMessage: '這則訊息沒有可下載的檔案' })
  }

  // 客服自己送出去的圖／影／音本來就帶網址（存在 Storage 或外部），不必再找 LINE 要
  const ownUrl = String(payload.originalContentUrl || '').trim()
  if (ownUrl) {
    return { state: 'ready' as const, url: ownUrl, contentType: '', bytes: 0 }
  }

  const lineMessageId = String(payload.id || '').trim()
  if (!lineMessageId) {
    return { state: 'error' as const, detail: '這則訊息沒有留下檔案編號' }
  }

  return await resolveConversationMediaUrl({ workspaceId, lineMessageId, messageType })
})
