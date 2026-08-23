import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
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
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')

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
  return { id, ...snap.data(), ...updates }
})
