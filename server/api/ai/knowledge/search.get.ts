import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import type { KnowledgeChunkStatus } from '~~/shared/types/ai-knowledge'

/** 與知識庫體檢同一個掃描上限：搜尋是「找那張卡」的工具，不是完整報表 */
const SCAN_LIMIT = 1500
const MAX_RESULTS = 30

export interface KnowledgeSearchRow {
  id: string
  sourceId: string | null
  title: string
  snippet: string
  /**
   * ⚠️ `draft`＝還在「等你看過」、客人問不會用到（`C-308`⑦）：畫面要標出來，
   * 不然他搜到了以為 AI 會答（正式庫目前 0 個帳號中，但每個走開帳的新帳號都會中）。
   */
  status: KnowledgeChunkStatus
}

/**
 * GET /api/ai/knowledge/search?q=關鍵字
 *
 * 知識卡全庫關鍵字搜尋（標題 / 內容 / 客人問法）。補卡前先確認「這題是不是已經有卡」——
 * 過去只能一個來源一個來源點開看。Firestore 沒有全文檢索，這裡掃前 SCAN_LIMIT 張
 * 在記憶體比對（體檢端點同一做法，量級已驗證可行）。
 * 排序：上線的排在「等你看過」的前面，同一組裡照命中位置（他要找的多半是 AI 現在在用的那一條）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'ai.read')
  const q = String(getQuery(event).q ?? '').trim().toLowerCase()
  if (!q) return { items: [], truncated: false }

  const db = getDb()
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .select('title', 'content', 'questions', 'sourceId', 'status', 'deletedAt', 'isDeleted')
    .limit(SCAN_LIMIT)
    .get()

  const scored: Array<KnowledgeSearchRow & { score: number }> = []
  for (const d of snap.docs) {
    const c = d.data() as { title?: string; content?: string; questions?: string[]; sourceId?: string | null; status?: string; deletedAt?: unknown; isDeleted?: boolean }
    // 回收桶的卡不進搜尋結果（兩個欄位都認：舊資料只有 deletedAt，同 chunkCountsTowardQuota 的 isDeleted）
    if (c.deletedAt != null || c.isDeleted === true) continue
    const title = String(c.title ?? '')
    const content = String(c.content ?? '')
    const questions = (c.questions ?? []).map(String)

    // 命中位置決定排序權重：標題 > 客人問法 > 內容
    let score = 0
    if (title.toLowerCase().includes(q)) score += 3
    if (questions.some(x => x.toLowerCase().includes(q))) score += 2
    const contentIdx = content.toLowerCase().indexOf(q)
    if (contentIdx >= 0) score += 1
    if (!score) continue

    // 摘要：內容有命中就擷取命中前後文，否則拿開頭
    const snippet = contentIdx >= 0
      ? (contentIdx > 20 ? '…' : '') + content.slice(Math.max(0, contentIdx - 20), contentIdx + 60) + (contentIdx + 60 < content.length ? '…' : '')
      : content.slice(0, 80) + (content.length > 80 ? '…' : '')

    scored.push({
      id: d.id,
      sourceId: c.sourceId != null ? String(c.sourceId) : null,
      title,
      snippet,
      status: (c.status ?? 'pending') as KnowledgeChunkStatus,
      score,
    })
  }

  // 上線的在前、等你看過的在後（`C-308`⑦）；同一組照命中位置。Array.sort 是穩定排序，同分照原本順序
  const isDraft = (r: KnowledgeSearchRow) => (r.status === 'draft' ? 1 : 0)
  scored.sort((a, b) => isDraft(a) - isDraft(b) || b.score - a.score)
  return {
    items: scored.slice(0, MAX_RESULTS).map(({ score: _score, ...row }) => row),
    /** 卡片總數撞到掃描上限：有些卡根本沒被比對到 */
    truncated: snap.size >= SCAN_LIMIT,
    /** 命中數超過顯示上限：畫面上少列了幾筆，要講出來 */
    countTruncated: scored.length > MAX_RESULTS,
  }
})
