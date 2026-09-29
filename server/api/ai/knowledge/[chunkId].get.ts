import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'

/**
 * GET /api/ai/knowledge/:chunkId
 * 取單張卡的基本資料。給「來源頁 ?chunkId= deep link」反查所屬 source 用
 * (例:測試對話頁點「編輯」→ 來源頁自動選取該來源並開啟編輯視窗)。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'ai.read')
  const chunkId = String(getRouterParam(event, 'chunkId') ?? '').trim()
  if (!chunkId) throw createError({ statusCode: 400, statusMessage: 'chunkId required' })

  const snap = await getDb().collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId).get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: 'chunk not found' })
  const data = snap.data() as any
  if (data?.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'chunk not found' })
  }

  return {
    id: snap.id,
    sourceId: data?.sourceId != null ? String(data.sourceId) : null,
    title: String(data?.title ?? ''),
  }
})
