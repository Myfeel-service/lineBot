import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { buildEmbeddingText, KNOWLEDGE_CHUNKS_COLLECTION, runIndexOnChunk } from '~~/server/utils/ai-knowledge-chunks'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/ai/knowledge/:chunkId/reindex
 *
 * 手動觸發單張卡重新算 embedding。供「索引失敗」狀態下使用者點重試。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'knowledge.write')
  const chunkId = String(getRouterParam(event, 'chunkId') ?? '').trim()
  if (!chunkId) throw createError({ statusCode: 400, statusMessage: 'chunkId required' })

  const db = getDb()
  const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId)
  const snap = await ref.get()
  if (!snap.exists) throw createError({ statusCode: 404, statusMessage: 'chunk not found' })
  const data = snap.data() as { workspaceId?: string; title?: string; content?: string; questions?: unknown }
  if (data.workspaceId !== workspaceId) {
    throw createError({ statusCode: 404, statusMessage: 'chunk not found' })
  }
  const content = String(data.content ?? '').trim()
  if (!content) throw createError({ statusCode: 400, statusMessage: 'chunk has no content' })

  const result = await runIndexOnChunk(db, chunkId, buildEmbeddingText(
    String(data.title ?? ''),
    content,
    Array.isArray(data.questions) ? data.questions.map(String) : [],
  ), workspaceId)

  // 稽核（`C-254`）：重新學習會花 embedding 的錢，而且結果可能還是失敗——
  // ⛔ 成功失敗都要記，只記成功的話「按了十次都沒好」在紀錄上會看不出來
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'knowledge.reindex',
    targetId: chunkId,
    after: { title: String(data.title ?? ''), cardStatus: result.status },
    ...(result.failureReason ? { note: `還是沒學成功：${result.failureReason}` } : {}),
  }, db)

  return result
})
