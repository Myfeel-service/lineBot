import { getDb } from '~~/server/utils/firebase'
import { normalizeSupportPreset } from '~~/shared/support-preset'
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

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

  const userId = getRouterParam(event, 'userId')
  if (!userId) throw createError({ statusCode: 400, statusMessage: 'userId required' })

  const body = await readBody(event)
  const presetId = String(body?.presetId || '').trim()
  if (!presetId) throw createError({ statusCode: 400, statusMessage: '請選擇預存' })

  const db = getDb()
  const userSnap = await db.collection('users').doc(userId).get()
  if (!userSnap.exists || userSnap.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: '找不到此使用者' })
  }

  const presetSnap = await db.collection('supportPresets').doc(presetId).get()
  if (!presetSnap.exists) throw createError({ statusCode: 404, statusMessage: '找不到此預存' })

  const preset = normalizeSupportPreset({ id: presetSnap.id, ...presetSnap.data() })
  if (!preset.isActive) {
    throw createError({ statusCode: 400, statusMessage: '此預存已停用' })
  }

  const requestOrigin = resolveRequestOrigin(event)
  try {
    await pushSupportPresetActionToUser(
      userId,
      preset.action,
      preset.tagging,
      presetId,
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
