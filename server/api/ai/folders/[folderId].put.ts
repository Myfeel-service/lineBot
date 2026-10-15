import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { updateFolder } from '~~/server/utils/ai-knowledge-folders'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * PUT /api/ai/folders/:folderId
 * Body: { name?, general? }——至少帶一格。
 *
 * `general`（`C-320`）：true＝「通用」分組（FAQ、公告、價目表這種不是講單一商品的），false＝商品分組。
 * 只改這一格，⛔ 不動底下任何一份的產品名（見 updateFolder）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'folders.write')
  const folderId = String(getRouterParam(event, 'folderId') ?? '').trim()
  if (!folderId) throw createError({ statusCode: 400, statusMessage: 'folderId required' })

  const body = await readBody(event).catch(() => ({}))
  const name = body?.name === undefined ? undefined : String(body.name ?? '').trim()
  const general = typeof body?.general === 'boolean' ? body.general : undefined
  // 帶了 name 卻是空的＝照舊擋（以前這支只收 name）；兩格都沒帶也擋
  if (name === '' || (name === undefined && general === undefined)) {
    throw createError({ statusCode: 400, statusMessage: '請輸入資料夾名稱' })
  }

  const db = getDb()
  const result = await updateFolder(db, workspaceId, folderId, { name, general })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'folder not found' })

  const generalChanged = result.before.general !== result.after.general
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledgeFolder.put',
    targetId: folderId,
    after: { name: result.after.name },
    // 「通用」這一格寫在備註：操作紀錄的欄位名對照表沒有它，放進前後對照只會顯示英文 key
    ...(generalChanged
      ? { note: `「${result.after.name}」改成${result.after.general ? '通用（不是講單一商品）' : '商品分組'}` }
      : {}),
  }, db)
  return result.after
})
