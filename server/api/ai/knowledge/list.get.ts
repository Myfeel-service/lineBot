import { getDb } from '~~/server/utils/firebase'
import { queryCollectionPage } from '~~/server/utils/paginated-collection-list'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'

/**
 * GET /api/ai/knowledge/list
 * Query: page, limit, status?, tag?, sourceId?
 *
 * 回傳的卡會附上 sourceName / sourceType（從 knowledgeSources join；單次查詢補一個 batch get），
 * 讓前端列表可以顯示「這張來自哪個來源」。
 *
 * 注意：embedding 欄位被刻意剝除（768 floats × 4 bytes × N 卡 = 流量爆炸）。
 * 需要向量請走 vector search API（Phase 2）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const query = getQuery(event)
  const status = String(query.status ?? '').trim()
  const tag = String(query.tag ?? '').trim()
  const sourceIdFilter = String(query.sourceId ?? '').trim()
  const db = getDb()

  const result = await queryCollectionPage(
    db,
    (ref) => {
      let q: FirebaseFirestore.Query = ref.where('workspaceId', '==', workspaceId)
      if (status === 'pending' || status === 'indexed' || status === 'failed') {
        q = q.where('status', '==', status)
      }
      if (tag) q = q.where('tags', 'array-contains', tag)
      if (sourceIdFilter === '__manual__') q = q.where('sourceId', '==', null)
      else if (sourceIdFilter) q = q.where('sourceId', '==', sourceIdFilter)
      return q.orderBy('updatedAt', 'desc')
    },
    KNOWLEDGE_CHUNKS_COLLECTION,
    query,
    (id, data) => {
      const { embedding: _omit, ...rest } = data
      return { id, ...rest } as Record<string, unknown> & { id: string; sourceId?: string | null }
    },
  )

  const items = Array.isArray(result) ? result : result.items
  // 收集出現過的 sourceIds，batch get 它們的 name / type
  const sourceIds = Array.from(new Set(
    items.map(i => i.sourceId).filter((id): id is string => typeof id === 'string' && !!id),
  ))
  const sourceMap = new Map<string, { name: string; type: string }>()
  if (sourceIds.length) {
    const sourceDocs = await Promise.all(
      sourceIds.map(id => db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(id).get()),
    )
    for (const doc of sourceDocs) {
      if (!doc.exists) continue
      const d = doc.data() as { name?: string; type?: string; workspaceId?: string }
      // G-98：卡上的 sourceId 指到別家的來源（修好 create 之前寫得進來）→ 當作來源不存在，
      // 別家資料的名稱不可以從這裡讀出去
      if (d?.workspaceId !== workspaceId) continue
      sourceMap.set(doc.id, { name: String(d?.name ?? ''), type: String(d?.type ?? '') })
    }
  }
  for (const item of items) {
    const sid = item.sourceId
    const src = sid ? sourceMap.get(sid) : null
    ;(item as any).sourceName = src?.name ?? ''
    ;(item as any).sourceType = src?.type ?? (sid ? 'unknown' : 'manual')
  }
  return result
})
