import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { docToSourceSummary, getSource, listChunksBySource } from '~~/server/utils/ai-knowledge-sources'

/**
 * GET /api/ai/sources/:sourceId
 * 回傳 source summary + 旗下所有 chunk（給 source detail panel 用）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'ai.read')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const db = getDb()
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'source not found' })

  const chunks = await listChunksBySource(db, workspaceId, sourceId)
  return {
    source: docToSourceSummary(source.id, source.data),
    chunks,
  }
})
