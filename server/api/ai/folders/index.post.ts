import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { createFolder } from '~~/server/utils/ai-knowledge-folders'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/ai/folders
 * Body: { name: string, general?: boolean }
 *
 * `general: true`（`C-320`）：建成「通用」分組（不是講單一商品的資料放這裡）。沒帶＝商品分組，跟以前一樣。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'folders.write')
  const body = await readBody(event).catch(() => ({}))
  const name = String(body?.name ?? '').trim()
  if (!name) throw createError({ statusCode: 400, statusMessage: '請輸入資料夾名稱' })

  const db = getDb()
  const folder = await createFolder(db, workspaceId, name, { general: body?.general === true })
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledgeFolder.create',
    targetId: folder.id,
    after: { name: folder.name },
    ...(folder.general ? { note: `「${folder.name}」是通用（不是講單一商品）` } : {}),
  }, db)
  return folder
})
