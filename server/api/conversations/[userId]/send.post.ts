import type { messagingApi } from '@line/bot-sdk'
import { getDb } from '~~/server/utils/firebase'
import { pushMessage } from '~~/server/utils/line'
import { saveConversationMessage } from '~~/server/utils/handler'
import { onHumanOutgoingMessage } from '~~/server/utils/conversation-session'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { describeLineSendFailure } from '~~/server/utils/line-send-error'
import { lineUserIdFromFirestoreDocId } from '~~/shared/line-workspace'

/**
 * 推給客人；LINE 退件就翻成客服看得懂的原因。
 * 原本 pushMessage 的錯沒人接，客服不管什麼原因都只看到「發送失敗」——
 * 封鎖、當月額度用完、訊息太長，這三種的下一步完全不同。
 */
async function pushToCustomer(
  lineUserId: string,
  messages: messagingApi.Message[],
  workspaceId: string,
) {
  try {
    await pushMessage(lineUserId, messages, workspaceId)
  }
  catch (e) {
    const reason = describeLineSendFailure(e)
    // 不是 LINE 退件（例如頻道還沒設好）就原封不動往上丟，別把線索蓋掉
    if (!reason) throw e
    throw createError({ statusCode: 502, statusMessage: reason })
  }
}

export default defineEventHandler(async (event) => {
  const { workspaceId, token } = await requireWorkspaceAccess(event, 'agent')

  // 對話上「真人」標籤的 tooltip 要講出是哪位同事回的。收件匣是全團隊共用的，
  // 只寫「真人」等於還要再問一次「誰回的？」。取不到名字就退到 email，都沒有就留空。
  const operatorName = String(token.name || token.email || '').trim()

  const userId = getRouterParam(event, 'userId')
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })

  const body = await readBody(event)
  const type = String(body?.type || 'text').trim()

  const db = getDb()
  const userSnap = await db.collection('users').doc(userId).get()
  if (!userSnap.exists || userSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此使用者' })
  }

  const lineUserId = String(userSnap.data()?.lineUserId || '').trim() || lineUserIdFromFirestoreDocId(userId)

  const isHttpUrl = (input: unknown) => /^https?:\/\//i.test(String(input || '').trim())

  if (type === 'sticker') {
    const packageId = String(body?.packageId || '').trim()
    const stickerId = String(body?.stickerId || '').trim()
    if (!/^\d+$/.test(packageId) || !/^\d+$/.test(stickerId)) {
      throw createError({ statusCode: 400, statusMessage: 'packageId / stickerId 必須是數字字串' })
    }
    const message = { type: 'sticker' as const, packageId, stickerId }
    await pushToCustomer(lineUserId, [message], workspaceId)
    await saveConversationMessage(userId, 'outgoing', '[貼圖]', {
      messageType: 'sticker',
      payload: message,
      sender: 'human',
      senderName: operatorName,
    }, workspaceId)
    onHumanOutgoingMessage(userId, workspaceId).catch(e => console.error('[session] onHumanOutgoing error:', e))
    return { ok: true }
  }

  if (type === 'image') {
    const originalContentUrl = String(body?.originalContentUrl || '').trim()
    const previewImageUrl = String(body?.previewImageUrl || originalContentUrl).trim()
    if (!isHttpUrl(originalContentUrl) || !isHttpUrl(previewImageUrl)) {
      throw createError({ statusCode: 400, statusMessage: '圖片網址格式不正確' })
    }
    const message = { type: 'image' as const, originalContentUrl, previewImageUrl }
    await pushToCustomer(lineUserId, [message], workspaceId)
    await saveConversationMessage(userId, 'outgoing', '[圖片]', {
      messageType: 'image',
      payload: message,
      sender: 'human',
      senderName: operatorName,
    }, workspaceId)
    onHumanOutgoingMessage(userId, workspaceId).catch(e => console.error('[session] onHumanOutgoing error:', e))
    return { ok: true }
  }

  if (type === 'video') {
    const originalContentUrl = String(body?.originalContentUrl || '').trim()
    const previewImageUrl = String(body?.previewImageUrl || originalContentUrl).trim()
    if (!isHttpUrl(originalContentUrl) || !isHttpUrl(previewImageUrl)) {
      throw createError({ statusCode: 400, statusMessage: '影片網址格式不正確' })
    }
    const message = { type: 'video' as const, originalContentUrl, previewImageUrl }
    await pushToCustomer(lineUserId, [message], workspaceId)
    await saveConversationMessage(userId, 'outgoing', '[影片]', {
      messageType: 'video',
      payload: message,
      sender: 'human',
      senderName: operatorName,
    }, workspaceId)
    onHumanOutgoingMessage(userId, workspaceId).catch(e => console.error('[session] onHumanOutgoing error:', e))
    return { ok: true }
  }

  if (type === 'audio') {
    const originalContentUrl = String(body?.originalContentUrl || '').trim()
    const duration = Number(body?.duration ?? body?.durationMs)
    if (!isHttpUrl(originalContentUrl)) {
      throw createError({ statusCode: 400, statusMessage: '音訊參數不正確' })
    }
    const normalizedDuration = Number.isFinite(duration) && duration > 0
      ? Math.round(duration)
      : 5000
    const message = { type: 'audio' as const, originalContentUrl, duration: normalizedDuration }
    await pushToCustomer(lineUserId, [message as any], workspaceId)
    await saveConversationMessage(userId, 'outgoing', '[音訊]', {
      messageType: 'audio',
      payload: message,
      sender: 'human',
      senderName: operatorName,
    }, workspaceId)
    onHumanOutgoingMessage(userId, workspaceId).catch(e => console.error('[session] onHumanOutgoing error:', e))
    return { ok: true }
  }

  if (type === 'file') {
    const originalContentUrl = String(body?.originalContentUrl || '').trim()
    const fileName = String(body?.fileName || '檔案').trim() || '檔案'
    if (!isHttpUrl(originalContentUrl)) {
      throw createError({ statusCode: 400, statusMessage: '檔案參數不正確' })
    }
    // 部分 LINE 帳號不支援 direct file message（會要求 contentId），
    // 這裡改為送文字 + 下載連結以確保可送達。
    const message = { type: 'file' as const, originalContentUrl, fileName }
    const fallbackText = `📎 ${fileName}\n${originalContentUrl}`
    await pushToCustomer(lineUserId, [{ type: 'text', text: fallbackText } as any], workspaceId)
    await saveConversationMessage(userId, 'outgoing', `[檔案] ${fileName}`, {
      messageType: 'file',
      payload: message,
      sender: 'human',
      senderName: operatorName,
    }, workspaceId)
    onHumanOutgoingMessage(userId, workspaceId).catch(e => console.error('[session] onHumanOutgoing error:', e))
    return { ok: true }
  }

  const text: string = String(body?.text || '').trim()
  if (!text) throw createError({ statusCode: 400, statusMessage: 'text required' })

  const message = { type: 'text' as const, text }
  await pushToCustomer(lineUserId, [message], workspaceId)
  await saveConversationMessage(userId, 'outgoing', text, {
    messageType: 'text',
    payload: message,
    sender: 'human',
    senderName: operatorName,
  }, workspaceId)
  onHumanOutgoingMessage(userId, workspaceId).catch(e => console.error('[session] onHumanOutgoing error:', e))

  return { ok: true }
})
