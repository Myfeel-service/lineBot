import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { renameFolder } from '~~/server/utils/ai-knowledge-folders'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * PUT /api/ai/folders/:folderId
 * Body: { name }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'folders.write')
  const folderId = String(getRouterParam(event, 'folderId') ?? '').trim()
  if (!folderId) throw createError({ statusCode: 400, statusMessage: 'folderId required' })

  const body = await readBody(event).catch(() => ({}))
  const name = String(body?.name ?? '').trim()
  if (!name) throw createError({ statusCode: 400, statusMessage: '請輸入資料夾名稱' })

  const db = getDb()
  const result = await renameFolder(db, workspaceId, folderId, name)
  if (!result) throw createError({ statusCode: 404, statusMessage: 'folder not found' })

  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledgeFolder.put',
    targetId: folderId,
    after: { name: result.name },
  }, db)
  return result
})
