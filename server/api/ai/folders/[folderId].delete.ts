import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { deleteFolderCascade } from '~~/server/utils/ai-knowledge-folders'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/ai/folders/:folderId
 * 刪資料夾時不會刪底下的來源，只把它們的 folderId 設成 null（變未分類）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'folders.write')
  const folderId = String(getRouterParam(event, 'folderId') ?? '').trim()
  if (!folderId) throw createError({ statusCode: 400, statusMessage: 'folderId required' })

  const db = getDb()
  const result = await deleteFolderCascade(db, workspaceId, folderId)

  // 稽核（`C-254`）：來源沒被刪，但會全部掉回「未分類」——
  // 事後「我的資料怎麼跑掉了」的答案就是這一筆
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledgeFolder.delete',
    targetId: folderId,
    note: `底下 ${result.movedSources} 份資料改成未分類`,
  }, db)

  return result
})
