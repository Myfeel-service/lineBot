import {
  normalizeSupportPreset,
  validateSupportPreset,
} from '~~/shared/support-preset'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { writeAuditLog, diffChangedFields } from '~~/server/utils/audit-log'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')
  const id = getRouterParam(event, 'id')!
  const rawBody = await readBody(event)
  const body = normalizeSupportPreset(rawBody)
  const errorMessage = validateSupportPreset(body)
  if (errorMessage) {
    throw createError({ statusCode: 400, statusMessage: errorMessage })
  }

  const db = getDb()
  const existing = await db.collection('supportPresets').doc(id).get()
  if (!existing.exists || existing.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }

  const moduleId = body.action.type === 'module' ? body.action.moduleId : ''
  const updates = {
    name: body.name,
    action: body.action,
    moduleId,
    isActive: body.isActive,
    tagging: body.tagging,
  }

  await db.collection('supportPresets').doc(id).update(updates)

  // 稽核（`C-254`）：只比摘要層，沒有變就不寫
  const before = existing.data()!
  const summarize = (d: Record<string, unknown>) => ({
    name: String(d.name ?? ''),
    isActive: d.isActive === true,
    type: String((d.action as { type?: string } | null)?.type ?? ''),
  })
  const diff = diffChangedFields(summarize(before), summarize({ ...before, ...updates }))
  if (diff.changedKeys.length) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'supportPreset.put',
      targetId: id,
      before: diff.before,
      after: diff.after,
      note: String(before.name ?? ''),
    }, db)
  }

  return { id, ...updates }
})
