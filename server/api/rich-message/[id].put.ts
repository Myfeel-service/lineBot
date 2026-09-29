import {
  normalizeUnifiedActions,
  validateUnifiedAction,
} from '~~/shared/action-schema'
import { getDoc } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog, auditSnapshot, diffChangedFields } from '~~/server/utils/audit-log'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const existing = await getDoc<Record<string, unknown> & { workspaceId?: string }>('richMessages', id)
  if (!existing || existing.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  const body = await readBody(event)
  const { name, layoutId, heroImageWidth, heroImageHeight, transparentBackground, altText, heroImageUrl, actions, isActive } = body

  const updates: Record<string, unknown> = {}
  if (name !== undefined) {
    if (!String(name).trim()) throw createError({ statusCode: 400, statusMessage: 'name is required' })
    updates.name = String(name).trim()
  }
  if (layoutId !== undefined) updates.layoutId = layoutId
  if (heroImageWidth !== undefined) {
    updates.heroImageWidth = Number(heroImageWidth) > 0 ? Number(heroImageWidth) : undefined
  }
  if (heroImageHeight !== undefined) {
    updates.heroImageHeight = Number(heroImageHeight) > 0 ? Number(heroImageHeight) : undefined
  }
  if (transparentBackground !== undefined) updates.transparentBackground = Boolean(transparentBackground)
  if (altText !== undefined) {
    if (!String(altText).trim()) throw createError({ statusCode: 400, statusMessage: 'altText is required' })
    updates.altText = String(altText).trim()
  }
  if (heroImageUrl !== undefined) {
    const nextHeroImageUrl = String(heroImageUrl || '').trim()
    if (!nextHeroImageUrl) throw createError({ statusCode: 400, statusMessage: 'heroImageUrl is required' })
    updates.heroImageUrl = nextHeroImageUrl
  }
  if (actions !== undefined) {
    const normalizedActions = normalizeUnifiedActions(actions)
    if (normalizedActions.length < 1) throw createError({ statusCode: 400, statusMessage: 'actions are required' })
    for (const action of normalizedActions) {
      const error = validateUnifiedAction(action)
      if (error) {
        throw createError({ statusCode: 400, statusMessage: `slot ${action.slot}: ${error}` })
      }
    }
    updates.actions = normalizedActions
  }
  if (isActive !== undefined) updates.isActive = isActive

  await updateDoc('richMessages', id, updates)

  // 稽核（`C-254`）：只比摘要層，沒有變就不寫
  const summarize = (d: Record<string, unknown>) =>
    auditSnapshot(d, { keep: ['name', 'isActive', 'altText'], count: ['actions'] })!
  const diff = diffChangedFields(summarize(existing), summarize({ ...existing, ...updates }))
  if (diff.changedKeys.length) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'richMessage.put',
      targetId: id,
      before: diff.before,
      after: diff.after,
      note: String(existing.name ?? ''),
    })
  }

  return { id, ...updates }
})
