import { FieldValue } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/tag/:id
 *
 * 標籤不做物理刪除，改為 status: 'inactive'
 * 確保歷史貼標紀錄與報表不受影響
 *
 * Response: { success: true, id: string }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')

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

  await ref.update({ status: 'inactive', updatedAt: FieldValue.serverTimestamp() })

  // 稽核（`C-254`）。⚠️ 這裡的「刪」其實是停用（歷史貼標與報表要留著），
  // 但對使用者來說標籤就是不見了，所以照 `tag.delete` 記，前後值如實寫「停用」
  const tag = snap.data()!
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'tag.delete',
    targetId: id,
    before: { name: String(tag.name ?? ''), status: String(tag.status ?? 'active') },
    after: { status: 'inactive' },
    note: `${String(tag.name ?? '')}（改成停用，已經貼過的紀錄仍然保留）`,
  }, db)

  return { success: true, id }
})
