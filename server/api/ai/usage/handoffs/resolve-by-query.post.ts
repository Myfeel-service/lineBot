import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { resolveHandoffsByQueries } from '~~/server/utils/ai-knowledge-suggest'

/**
 * POST /api/ai/usage/handoffs/resolve-by-query
 * Body: { query }
 *
 * 從「補知識」入口（?q=）建完卡後呼叫：把問了同一句的轉真人案例自動標「已處理」，
 * 使用者不用再回監控頁逐筆按。比對用 aiMeta.lastQuery 全等（同一句才敢自動銷案）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const body = await readBody(event)
  const query = String(body?.query ?? '').trim()
  if (!query) throw createError({ statusCode: 400, statusMessage: 'query required' })

  const resolved = await resolveHandoffsByQueries(getDb(), workspaceId, [query])
  return { resolved }
})
