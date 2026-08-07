import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { isCustomerActionMessage } from '~~/shared/customer-action'

/**
 * GET /api/admin/onboarding/first-message?workspaceId=...
 *
 * 開通引導「見證時刻」專用：回報這個工作區有沒有收過客人訊息，有的話把**那句話**帶回來，
 * 讓精靈能回顯「收到了！你剛剛傳的『…』」。
 *
 * 為什麼不併進 setup-status：那支是健康卡的高頻輪詢，只需要 done/incomplete；
 * 這裡要多讀一次訊息子集合拿內容，只有精靈的等待卡在打（3–5 秒輪詢、收到即停）。
 *
 * 判定口徑與 setup-status 的 firstMessageReceived 一致：看 lastPeerActivityAt——
 * 只有「客人真的傳了訊息」會寫它；加好友的 customer_action 是 traceOnly 不會蓋。
 */

interface FirstMessageResponse {
  received: boolean
  /** 訊息文字。非文字訊息（貼圖／圖片…）時為空字串，用 messageType 標示 */
  text?: string
  messageType?: string
  /** ISO 時間字串 */
  at?: string
}

export default defineEventHandler(async (event): Promise<FirstMessageResponse> => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const wid = String(workspaceId || '').trim()
  if (!wid)
    throw createError({ statusCode: 400, statusMessage: 'workspaceId is required' })

  const db = getDb()

  // 單欄位 equality 查詢免索引；在記憶體挑「最近有客人說話」的那場對話
  const convSnap = await db
    .collection('conversations')
    .where('workspaceId', '==', wid)
    .limit(20)
    .get()

  let latestDocId: string | null = null
  let latestMs = 0
  for (const doc of convSnap.docs) {
    const at = doc.data()?.lastPeerActivityAt
    const ms = typeof at?.toMillis === 'function' ? at.toMillis() : 0
    if (ms > latestMs) {
      latestMs = ms
      latestDocId = doc.id
    }
  }

  if (!latestDocId)
    return { received: false }

  // 取該場對話最近幾則，找最新的一則「客人傳來的訊息」。
  // 只用 orderBy timestamp（子集合單欄位索引自動有）——加 direction 過濾會要複合索引，
  // 在記憶體挑就好。
  const msgSnap = await db
    .collection('conversations')
    .doc(latestDocId)
    .collection('messages')
    .orderBy('timestamp', 'desc')
    .limit(10)
    .get()

  for (const doc of msgSnap.docs) {
    const m = doc.data() as Record<string, unknown>
    if (m.direction !== 'incoming')
      continue
    if (isCustomerActionMessage(m.messageType))
      continue
    const ts = m.timestamp as { toDate?: () => Date } | undefined
    const messageType = String(m.messageType ?? 'text')
    return {
      received: true,
      text: messageType === 'text' ? String(m.text ?? '').slice(0, 200) : '',
      messageType,
      at: typeof ts?.toDate === 'function' ? ts.toDate().toISOString() : undefined,
    }
  }

  // 對話標記過 lastPeerActivityAt 但前 10 則翻不到 incoming（極端情況）：
  // 仍如實回報「收過」，只是沒有內容可回顯。
  return { received: true }
})
