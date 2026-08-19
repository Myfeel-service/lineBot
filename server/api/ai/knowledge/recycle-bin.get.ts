import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'

const LIST_LIMIT = 100

export interface RecycleBinRow {
  id: string
  title: string
  snippet: string
  sourceId: string | null
  sourceName: string | null
  deletedAtMs: number
  purgeAfterMs: number
}

/**
 * GET /api/ai/knowledge/recycle-bin
 *
 * 回收桶：最近被刪除（軟刪除）的知識卡，最新的在前。30 天保留期內可還原；
 * 過期由排程真刪。orderBy(deletedAt) 天然排除沒有這個欄位的正常卡，
 * 不需要 != null 的不等式（需要 workspaceId+deletedAt 複合索引）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'agent')
  const db = getDb()

  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .orderBy('deletedAt', 'desc')
    .select('title', 'content', 'sourceId', 'deletedAt', 'purgeAfter')
    .limit(LIST_LIMIT)
    .get()

  const rows = snap.docs.map((d) => {
    const c = d.data() as any
    const content = String(c?.content ?? '')
    return {
      id: d.id,
      title: String(c?.title ?? '(無標題)'),
      snippet: content.slice(0, 80) + (content.length > 80 ? '…' : ''),
      sourceId: c?.sourceId != null ? String(c.sourceId) : null,
      sourceName: null as string | null,
      deletedAtMs: typeof c?.deletedAt?.toMillis === 'function' ? c.deletedAt.toMillis() : 0,
      purgeAfterMs: typeof c?.purgeAfter?.toMillis === 'function' ? c.purgeAfter.toMillis() : 0,
    } satisfies RecycleBinRow
  })

  // 補來源名稱（一次 getAll，不逐筆 get）
  const sourceIds = [...new Set(rows.map(r => r.sourceId).filter((x): x is string => !!x))]
  if (sourceIds.length) {
    const snaps = await db.getAll(...sourceIds.map(id => db.collection(KNOWLEDGE_SOURCES_COLLECTION).doc(id)))
      .catch(() => [])
    const nameById = new Map<string, string>()
    for (const s of snaps) {
      if (s.exists) nameById.set(s.id, String((s.data() as any)?.name ?? ''))
    }
    for (const r of rows) {
      if (r.sourceId) r.sourceName = nameById.get(r.sourceId) || null
    }
  }

  return { items: rows, truncated: snap.size >= LIST_LIMIT }
})
