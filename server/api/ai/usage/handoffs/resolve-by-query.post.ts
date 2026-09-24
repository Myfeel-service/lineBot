import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { resolveHandoffsByQueries } from '~~/server/utils/ai-knowledge-suggest'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/ai/usage/handoffs/resolve-by-query
 * Body: { query }
 *
 * 從「補知識」入口（?q=）建完卡後呼叫：把問了同一句的轉真人案例自動標「已處理」，
 * 使用者不用再回監控頁逐筆按。比對用 aiMeta.lastQuery 全等（同一句才敢自動銷案）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)
  const query = String(body?.query ?? '').trim()
  if (!query) throw createError({ statusCode: 400, statusMessage: 'query required' })

  const db = getDb()
  const resolved = await resolveHandoffsByQueries(db, workspaceId, [query])

  // 稽核（`C-254`）：一次把好幾筆案例從待辦清單拿掉。
  // ⛔ 沒有真的動到任何一筆就不記（記了只是在紀錄裡長出空行）。
  if (resolved > 0) {
    await writeAuditLog({
      workspaceId,
      uid,
      actor: 'human',
      action: 'handoff.resolveByQuery',
      after: { itemsCount: resolved },
      note: `問「${query}」的 ${resolved} 筆案例標成已處理`,
    }, db)
  }

  return { resolved }
})
