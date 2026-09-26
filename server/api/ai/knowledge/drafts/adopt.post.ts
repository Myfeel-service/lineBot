import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { adoptDrafts } from '~~/server/utils/knowledge-drafts'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/ai/knowledge/drafts/adopt  body: { chunkIds: string[] }
 *
 * 點頭：「等你看過」→ 可用（從這一刻起 AI 對客人才會用這幾張）。**額度不夠就收到滿為止**，
 * 回傳沒收到的那幾張，畫面要講出來（`C-250`③）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody<{ chunkIds?: unknown }>(event)
  const ids = Array.isArray(body?.chunkIds) ? body.chunkIds.map(String) : []
  if (!ids.length) throw createError({ statusCode: 400, statusMessage: '要採用哪幾張？' })
  const db = getDb()
  const r = await adoptDrafts(workspaceId, ids, db)
  if (r.adopted.length || r.leftForQuota.length) {
    // 稽核：知識卡張數是計費維度；而且從這一刻起客人會聽到這幾張的內容
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'knowledge.draftAdopt',
      after: { adoptedCount: r.adopted.length, leftForQuotaCount: r.leftForQuota.length },
      ...(r.adopted.length === 1 ? { targetId: r.adopted[0] } : {}),
      ...(r.leftForQuota.length ? { note: `額度滿了，還有 ${r.leftForQuota.length} 張沒收` } : {}),
    }, db)
  }
  return r
})
