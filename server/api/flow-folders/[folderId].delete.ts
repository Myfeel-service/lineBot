import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { deleteFlowFolderCascade } from '~~/server/utils/flow-folders'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/flow-folders/:folderId
 * 刪資料夾不會刪底下 flows，只把它們的 folderId 改成 null（變未分類）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')
  const folderId = String(getRouterParam(event, 'folderId') ?? '').trim()
  if (!folderId) throw createError({ statusCode: 400, statusMessage: 'folderId required' })

  const db = getDb()
  const result = await deleteFlowFolderCascade(db, workspaceId, folderId)

  // 稽核（`C-254`）：模組本身沒被刪，但它們會全部掉回「未分類」——
  // 事後「東西怎麼跑掉了」的疑問，答案就是這一筆
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'flowFolder.delete',
    targetId: folderId,
    note: `底下 ${result.movedFlows} 個模組改成未分類`,
  }, db)
  return result
})
