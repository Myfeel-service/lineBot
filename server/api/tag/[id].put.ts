import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { writeAuditLog, auditSnapshot, diffChangedFields } from '~~/server/utils/audit-log'
import type { TagCategory, TagStatus } from '~~/shared/types/tag-broadcast'

/**
 * PUT /api/tag/:id
 *
 * Body（所有欄位皆為可選，只傳要更新的）:
 * {
 *   name?: string
 *   category?: TagCategory
 *   color?: string
 *   description?: string
 *   status?: 'active' | 'inactive'
 * }
 *
 * Note: code 不允許修改
 *
 * Response: { id: string, ...updatedFields }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'tags.write')

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id is required' })

  const db = getDb()
  const ref = db.collection('tags').doc(id)
  const snap = await ref.get()

  if (!snap.exists) {
    throw createError({ statusCode: 404, statusMessage: 'Tag not found' })
  }

  if (snap.data()!.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'Tag not found' })
  }

  const body = await readBody(event)
  const allowed: (keyof Pick<any, 'name' | 'category' | 'color' | 'description' | 'status'>)[] =
    ['name', 'category', 'color', 'description', 'status']

  const updates: Record<string, any> = { updatedAt: FieldValue.serverTimestamp() }
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key]
  }
  // AI 判斷三段（D-27）：白名單驗證，壞值一律回 off；條件文字對齊編輯器上限 200 字
  if (body.aiMode !== undefined) {
    updates.aiMode = body.aiMode === 'suggest' || body.aiMode === 'auto' ? body.aiMode : 'off'
  }
  if (body.aiCriteria !== undefined) {
    updates.aiCriteria = String(body.aiCriteria ?? '').trim().slice(0, 200)
  }

  await ref.update(updates)

  // 稽核（`C-254`）。⭐ 最要緊的是 `aiMode`：從 `off` 改成 `auto` 等於放 AI 自己去貼這個標籤，
  // 而客人名單一旦被貼髒，是靜靜髒掉、沒有人會發現的那種
  const before = snap.data()!
  const summarize = (d: Record<string, unknown>) =>
    auditSnapshot(d, { keep: ['name', 'category', 'color', 'description', 'status', 'aiMode', 'aiCriteria'] })!
  const diff = diffChangedFields(summarize(before), summarize({ ...before, ...updates }))
  if (diff.changedKeys.length) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'tag.put',
      targetId: id,
      before: diff.before,
      after: diff.after,
      note: String(before.name ?? ''),
    }, db)
  }

  return { id, ...snap.data(), ...updates }
})
