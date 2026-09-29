import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { reorderFlowFolders } from '~~/server/utils/flow-folders'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/flow-folders/reorder
 * Body: { orderedIds: string[] } — 全部資料夾的新順序
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
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
  await reorderFlowFolders(db, workspaceId, ids)
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'flowFolder.reorder',
    after: { itemsCount: ids.length },
  }, db)
  return { success: true }
})
