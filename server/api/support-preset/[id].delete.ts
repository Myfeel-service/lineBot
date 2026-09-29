import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'presets.write')
  const id = getRouterParam(event, 'id')!
  const db = getDb()
  const existing = await db.collection('supportPresets').doc(id).get()
  if (!existing.exists || existing.data()?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  await db.collection('supportPresets').doc(id).delete()

  // 稽核（`C-254`）：這是真的刪掉，救不回來，名字要留得下
  const before = existing.data()!
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'supportPreset.delete',
    targetId: id,
    before: { name: String(before.name ?? ''), isActive: before.isActive === true },
    note: String(before.name ?? ''),
  }, db)

  return { id }
})
