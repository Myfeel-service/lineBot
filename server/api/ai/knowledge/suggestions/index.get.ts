import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_SUGGESTIONS_COLLECTION, getGapScanState } from '~~/server/utils/ai-knowledge-suggest'
import type { KnowledgeSuggestionDoc, KnowledgeSuggestionDraft } from '~~/shared/types/ai-knowledge'
import { isRawSuggestionTopic } from '~~/shared/knowledge-suggestion-topic'

export interface KnowledgeSuggestionRow {
  id: string
  topic: string
  /** topic 是客人原句（不是 AI 起的主題名）；伺服器這裡判好，畫面不必拿到全部 30 條問句再自己猜（見 isRawSuggestionTopic） */
  topicIsRaw: boolean
  eventCount: number
  /** 次數是取樣值（事件撞到掃描上限）→ UI 要說「至少 N 次」 */
  sampled: boolean
  sampleQueries: string[]
  /**
   * 這一組全部的客人原句（最多 30 條）（`C-311`）：審核時勾「這一條回答了哪幾題」用。
   * 只給 5 條樣本的話，沒列出來的那些勾不到、採用後會莫名其妙留在清單上
   */
  queries: string[]
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
  const { workspaceId } = await requireCapability(event, 'ai.read')
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
        topicIsRaw: isRawSuggestionTopic({ topic: String(s.topic ?? ''), topicIsRaw: s.topicIsRaw, sampleQueries: s.sampleQueries, queries: s.queries }),
        eventCount: Number(s.eventCount ?? 0),
        sampled: s.sampled === true,
        sampleQueries: (s.sampleQueries ?? []).map(String),
        // 舊資料理論上都有 queries；萬一沒有就退回樣本句（跟採用端 splitSuggestionQueries 同一個退路）
        queries: (s.queries?.length ? s.queries : (s.sampleQueries ?? [])).map(String),
        draft: s.draft ?? null,
        blanksCount: Number(s.blanksCount ?? 0),
        draftError: String(s.draftError ?? ''),
        lastSeenAtMs: tsToMs(s.lastSeenAt),
      }
    })
    .sort((a, b) => b.eventCount - a.eventCount || b.lastSeenAtMs - a.lastSeenAtMs)

  return { items, scan }
})
