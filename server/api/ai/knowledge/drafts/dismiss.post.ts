import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { dismissDrafts } from '~~/server/utils/knowledge-drafts'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/ai/knowledge/drafts/dismiss  body: { chunkIds: string[] }
 *
 * 刪掉還沒點頭的卡（真刪，不進回收桶——那是一份沒答應過的提案）。
 * ⛔ 只刪得到 `draft`：已經採用的卡走原本的刪除（回收桶，30 天內救得回來）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
  const body = await readBody<{ chunkIds?: unknown }>(event)
  const ids = Array.isArray(body?.chunkIds) ? body.chunkIds.map(String) : []
  if (!ids.length) throw createError({ statusCode: 400, statusMessage: '要刪哪幾張？' })
  const db = getDb()
  const r = await dismissDrafts(workspaceId, ids, db)
  if (r.dismissed.length) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'knowledge.draftDismiss',
      after: { dismissedCount: r.dismissed.length },
      ...(r.dismissed.length === 1 ? { targetId: r.dismissed[0] } : {}),
    }, db)
  }
  return r
})
