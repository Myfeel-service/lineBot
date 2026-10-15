import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { deleteFolderCascade } from '~~/server/utils/ai-knowledge-folders'
import { invalidateSourceProductCache, invalidateWorkspaceProductNames } from '~~/server/utils/ai-knowledge-chunks'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * DELETE /api/ai/folders/:folderId
 * 刪資料夾時不會刪底下的來源，只把它們的 folderId 設成 null（變未分類）。
 *
 * `D-127` 分組就是商品：未分類＝不是講單一商品，底下有商品名的那幾份一起清掉，回 `relearnSourceIds`——
 * 畫面要一份份打 POST /api/ai/sources/:id/reindex 重新學習，AI 才不會繼續把它們當成那一台。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'folders.write')
  const folderId = String(getRouterParam(event, 'folderId') ?? '').trim()
  if (!folderId) throw createError({ statusCode: 400, statusMessage: 'folderId required' })

  const db = getDb()
  const result = await deleteFolderCascade(db, workspaceId, folderId)
  for (const id of result.clearedProductSourceIds) invalidateSourceProductCache(id)
  if (result.clearedProductSourceIds.length) invalidateWorkspaceProductNames(workspaceId)

  // 稽核（`C-254`）：來源沒被刪，但會全部掉回「未分類」——
  // 事後「我的資料怎麼跑掉了」的答案就是這一筆
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledgeFolder.delete',
    targetId: folderId,
    note: `底下 ${result.movedSources} 份資料改成未分類`
      + (result.clearedProductSourceIds.length ? `，其中 ${result.clearedProductSourceIds.length} 份不再當成那一台的資料` : ''),
  }, db)

  return { movedSources: result.movedSources, relearnSourceIds: result.clearedProductSourceIds }
})
