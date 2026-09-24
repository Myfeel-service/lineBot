import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { renameFlowFolder } from '~~/server/utils/flow-folders'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * PUT /api/flow-folders/:folderId
 * Body: { name }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')
  const folderId = String(getRouterParam(event, 'folderId') ?? '').trim()
  if (!folderId) throw createError({ statusCode: 400, statusMessage: 'folderId required' })

  const body = await readBody(event).catch(() => ({}))
  const name = String(body?.name ?? '').trim()
  if (!name) throw createError({ statusCode: 400, statusMessage: '請輸入資料夾名稱' })

  const db = getDb()
  const result = await renameFlowFolder(db, workspaceId, folderId, name)
  if (!result) throw createError({ statusCode: 404, statusMessage: 'folder not found' })

  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'flowFolder.put',
    targetId: folderId,
    after: { name: result.name },
  }, db)
  return result
})
