import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { reorderFolders } from '~~/server/utils/ai-knowledge-folders'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/ai/folders/reorder
 * Body: { orderedIds: string[] } — 全部資料夾的新順序
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'folders.write')
  const body = await readBody(event).catch(() => ({}))
  const orderedIds = body?.orderedIds

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'orderedIds is required' })
  }
  const ids = orderedIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
  if (ids.length !== orderedIds.length) {
    throw createError({ statusCode: 400, statusMessage: 'orderedIds 格式錯誤' })
  }

  const db = getDb()
  await reorderFolders(db, workspaceId, ids)
  // 只記「動了幾個」：⛔ 整串 id 塞進紀錄沒有人看得懂
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledgeFolder.reorder',
    after: { itemsCount: ids.length },
  }, db)
  return { success: true }
})
