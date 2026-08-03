import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_SUGGESTIONS_COLLECTION, getGapScanState } from '~~/server/utils/ai-knowledge-suggest'
import type { KnowledgeSuggestionDoc, KnowledgeSuggestionDraft } from '~~/shared/types/ai-knowledge'

export interface KnowledgeSuggestionRow {
  id: string
  topic: string
  eventCount: number
  /** 次數是取樣值（事件撞到掃描上限）→ UI 要說「至少 N 次」 */
  sampled: boolean
  sampleQueries: string[]
  draft: KnowledgeSuggestionDraft | null
  blanksCount: number
  draftError: string
  lastSeenAtMs: number
}

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

/**
 * GET /api/ai/knowledge/suggestions
 *
 * 建議收件匣：待處理的知識缺口建議（含 LLM 草稿），照被問次數排序。
 * scan 給 UI 顯示「上次掃描時間」與「已排入重新掃描」。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const db = getDb()

  // 等值查詢（workspaceId + status）走自動索引；排序量小放記憶體做，免建複合索引
  const [snap, scan] = await Promise.all([
    db.collection(KNOWLEDGE_SUGGESTIONS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .where('status', '==', 'pending')
      .limit(50)
      .get(),
    getGapScanState(db, workspaceId),
  ])

  const items: KnowledgeSuggestionRow[] = snap.docs
    .map((d) => {
      const s = d.data() as KnowledgeSuggestionDoc
      return {
        id: d.id,
        topic: String(s.topic ?? '(未命名主題)'),
        eventCount: Number(s.eventCount ?? 0),
        sampled: s.sampled === true,
        sampleQueries: (s.sampleQueries ?? []).map(String),
        draft: s.draft ?? null,
        blanksCount: Number(s.blanksCount ?? 0),
        draftError: String(s.draftError ?? ''),
        lastSeenAtMs: tsToMs(s.lastSeenAt),
      }
    })
    .sort((a, b) => b.eventCount - a.eventCount || b.lastSeenAtMs - a.lastSeenAtMs)

  return { items, scan }
})
