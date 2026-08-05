import { getDb } from '~~/server/utils/firebase'
import { normalizeSupportPreset } from '~~/shared/support-preset'
import { normalizeAutoReplyRule } from '~~/shared/auto-reply-rule'
import { renderTextForUser } from '~~/server/utils/handler'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

/**
 * GET /api/conversations/[userId]/quick-reply-text?presetId=xxx
 * GET /api/conversations/[userId]/quick-reply-text?ruleId=xxx
 *
 * 「填入回覆框」用：拿這則客服預存／自動回覆的文字，讓客服改完再自己送出。
 * 只有 message 型別有可編輯的文字；module（觸發機器人模組）與 uri（按鈕卡）
 * 沒有純文字可改，回 text: null，前端只給「直接送出」。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const userId = getRouterParam(event, 'userId')
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })

  const query = getQuery(event)
  const presetId = String(query?.presetId || '').trim()
  const ruleId = String(query?.ruleId || '').trim()
  if (!presetId && !ruleId) {
    throw createError({ statusCode: 400, statusMessage: '請選擇要填入的項目' })
  }

  const db = getDb()
  const userSnap = await db.collection('users').doc(userId).get()
  if (!userSnap.exists || userSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此使用者' })
  }

  const collection = presetId ? 'supportPresets' : 'autoReplies'
  const docId = presetId || ruleId
  const snap = await db.collection(collection).doc(docId).get()
  if (!snap.exists || snap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: presetId ? '找不到此預存' : '找不到此自動回覆規則' })
  }

  const raw = { id: snap.id, ...snap.data() }
  const action = presetId
    ? normalizeSupportPreset(raw).action
    : normalizeAutoReplyRule(raw).action

  if (action.type !== 'message' || !action.text) {
    return { text: null as string | null }
  }

  return { text: renderTextForUser(action.text, userSnap.data() ?? null) }
})
