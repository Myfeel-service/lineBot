import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import {
  normalizeUnifiedActions,
  validateUnifiedAction,
} from '~~/shared/action-schema'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
  const body = await readBody(event)
  const { name, layoutId, heroImageWidth, heroImageHeight, transparentBackground, altText, heroImageUrl, actions, isActive } = body

  if (!name?.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'name is required' })
  }
  if (!altText?.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'altText is required' })
  }
  if (!heroImageUrl?.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'heroImageUrl is required' })
  }
  const normalizedActions = normalizeUnifiedActions(actions)
  if (!Array.isArray(normalizedActions) || normalizedActions.length < 1) {
    throw createError({ statusCode: 400, statusMessage: 'actions are required' })
  }
  for (const action of normalizedActions) {
    const error = validateUnifiedAction(action)
    if (error) {
      throw createError({ statusCode: 400, statusMessage: `slot ${action.slot}: ${error}` })
    }
  }
  const id = uuidv4()
  const doc = await createDoc('richMessages', id, {
    name: String(name).trim(),
    layoutId: typeof layoutId === 'string' ? layoutId : 'custom',
    heroImageWidth: Number(heroImageWidth) > 0 ? Number(heroImageWidth) : undefined,
    heroImageHeight: Number(heroImageHeight) > 0 ? Number(heroImageHeight) : undefined,
    transparentBackground: Boolean(transparentBackground),
    altText: String(altText).trim(),
    heroImageUrl: typeof heroImageUrl === 'string' ? heroImageUrl.trim() : '',
    actions: normalizedActions,
    isActive: isActive ?? true,
    workspaceId,
    createdAt: FieldValue.serverTimestamp(),
  })

  // 稽核（`C-254`）：圖文訊息是模組裡客人會看到、會按的那張圖
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'richMessage.create',
    targetId: id,
    after: {
      name: String(name).trim(),
      isActive: isActive ?? true,
      areasCount: normalizedActions.length,
    },
  })

  return doc
})
