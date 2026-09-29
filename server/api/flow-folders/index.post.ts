import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { createFlowFolder } from '~~/server/utils/flow-folders'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/flow-folders
 * Body: { name }
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'marketing.write')
  const body = await readBody(event).catch(() => ({}))
  const name = String(body?.name ?? '').trim()
  if (!name) throw createError({ statusCode: 400, statusMessage: '請輸入資料夾名稱' })

  const db = getDb()
  const folder = await createFlowFolder(db, workspaceId, name)
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'flowFolder.create',
    targetId: folder.id,
    after: { name: folder.name },
  }, db)
  return folder
})
