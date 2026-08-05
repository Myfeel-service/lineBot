import { getDb } from '~~/server/utils/firebase'
import { normalizeAutoReplyRule } from '~~/shared/auto-reply-rule'
import { pushSupportPresetActionToUser } from '~~/server/utils/handler'
import { describeLineSendFailure } from '~~/server/utils/line-send-error'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'

function resolveRequestOrigin(event: Parameters<typeof getHeader>[0]): string {
  const protoRaw = String(getHeader(event, 'x-forwarded-proto') || 'https')
  const hostRaw = String(getHeader(event, 'x-forwarded-host') || getHeader(event, 'host') || '')
  const proto = (protoRaw.split(',')[0] ?? '').trim().toLowerCase()
  const host = (hostRaw.split(',')[0] ?? '').trim()
  if (!host) return ''
  const safeProto = proto === 'http' || proto === 'https' ? proto : 'https'
  return `${safeProto}://${host}`
}

/**
 * POST /api/conversations/:userId/send-auto-reply
 *
 * 對話頁手動挑一則「自動回覆」規則送出——借用那條規則的內容，不用重打一次。
 * 與規則被關鍵字命中的差別只有兩個：
 *   - 不看 matchType、也不寫冷卻（cooldown 是「客人自己觸發」的節流，人工送出不套）
 *   - 送出算真人客服動作（pushSupportPresetActionToUser 內會記 onHumanOutgoingMessage），
 *     所以這場會話會轉真人處理、機器人／AI 不再自動回覆，直到交還機器人
 *
 * 動作／標籤的處理完全沿用客服預存那條路徑（兩者的 action 是同一個 shape）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const userId = getRouterParam(event, 'userId')
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })

  const body = await readBody(event)
  const ruleId = String(body?.ruleId || '').trim()
  if (!ruleId) throw createError({ statusCode: 400, statusMessage: '請選擇自動回覆' })

  const db = getDb()
  const userSnap = await db.collection('users').doc(userId).get()
  if (!userSnap.exists || userSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此使用者' })
  }

  const ruleSnap = await db.collection('autoReplies').doc(ruleId).get()
  if (!ruleSnap.exists || ruleSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此自動回覆' })
  }

  const rule = normalizeAutoReplyRule({ id: ruleSnap.id, ...ruleSnap.data() })
  if (!rule.isActive) {
    throw createError({ statusCode: 400, statusMessage: '此自動回覆已停用' })
  }

  const requestOrigin = resolveRequestOrigin(event)
  try {
    await pushSupportPresetActionToUser(
      userId,
      rule.action,
      rule.tagging,
      ruleId,
      requestOrigin,
      workspaceId,
    )
  }
  catch (e) {
    // LINE 退件就講原因（封鎖／額度／太長）；其他錯（例如模組不存在）原封不動往上丟
    const reason = describeLineSendFailure(e)
    if (!reason) throw e
    throw createError({ statusCode: 502, statusMessage: reason })
  }

  return { ok: true }
})
