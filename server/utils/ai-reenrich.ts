import type { Firestore } from 'firebase-admin/firestore'
import { KNOWLEDGE_CHUNKS_COLLECTION, updateKnowledgeChunk } from './ai-knowledge-chunks'
import { enrichCardsWithLlm, needsQuestionEnrichment } from './ai-knowledge-chunker'
import { recordAiUsage } from './ai-usage'

/** 每批掃描幾張卡；也等於單批最多補幾張（≤ 90 → enrichCardsWithLlm 最多 6 個並行 LLM 呼叫）。 */
export const REENRICH_SCAN_LIMIT = 90

/** 套用（reindex）併發，同 reindex-all 的保守值。 */
export const REENRICH_APPLY_CONCURRENCY = 5

export interface ReenrichResult {
  /** 本批掃描的卡數 */
  batch: number
  /** 本批需要補問法的卡數 */
  candidates: number
  /** 本批實際補上問法的卡數（LLM 沒回的不算） */
  enriched: number
  usage: { inputTokens: number; outputTokens: number }
  /** 非 null 代表可能還有下一批，呼叫端帶著它再呼叫；null 代表掃完了 */
  nextCursor: string | null
}

/**
 * 掃描一批工作區知識卡，對「沒問法、且非人工編輯／非總覽卡」的補上問法（只補不改 title / content）。
 * cursor 分頁（同 reindex-all），冪等可中斷重跑。純邏輯集中在此，端點只做權限 + 呼叫。
 */
export async function reenrichWorkspaceChunks(
  db: Firestore,
  workspaceId: string,
  cursor: string,
): Promise<ReenrichResult> {
  let q = db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .orderBy('__name__')
    .select('title', 'content', 'tags', 'questions', 'isOverview', 'manuallyEditedAt', 'status')
    .limit(REENRICH_SCAN_LIMIT)
  if (cursor) {
    q = q.startAfter(db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(cursor))
  }
  const snap = await q.get()

  const targets = snap.docs
    // 停用（含到期下架）的卡跳過：runIndexOnChunk 的守門已保證它們不會被復活，
    // 這裡再省下對隱藏卡白花的 LLM 補問法＋embedding 重算（等真的重新啟用再補不遲）。
    .filter(d => d.data()?.status !== 'disabled' && needsQuestionEnrichment(d.data()))
    .map((d) => {
      const data = d.data()
      return {
        id: d.id,
        title: String(data?.title ?? ''),
        content: String(data?.content ?? ''),
        tags: Array.isArray(data?.tags) ? data.tags.map(String) : [],
      }
    })

  const usage = { inputTokens: 0, outputTokens: 0 }
  let enriched = 0

  if (targets.length) {
    const res = await enrichCardsWithLlm(targets.map(t => ({ title: t.title, content: t.content })))
    usage.inputTokens = res.inputTokens
    usage.outputTokens = res.outputTokens
    if (res.inputTokens || res.outputTokens) {
      // 補問法 token 照實入帳（月度 quota + import 分項）；記帳失敗不擋回填
      await recordAiUsage(workspaceId, {
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        importInputTokens: res.inputTokens,
        importOutputTokens: res.outputTokens,
      }, db).catch(() => {})
    }

    // 套用：只補不改 title / content；沒補到（LLM 沒回）的留給下次重跑
    const applied = new Array(targets.length).fill(false)
    let ci = 0
    async function worker() {
      while (ci < targets.length) {
        const i = ci++
        const t = targets[i]!
        const extra = res.items[i]
        if (!extra?.questions.length) continue
        await updateKnowledgeChunk(db, {
          chunkId: t.id,
          title: t.title,
          content: t.content,
          // 只在原本沒標籤時補；有的話傳 undefined 保留既有
          tags: extra.tags.length && !t.tags.length ? extra.tags : undefined,
          questions: extra.questions,
          contentChanged: false, // 內容沒變，只補問法（questionsChanged 觸發 reindex）
          manualEdit: false,
        })
        applied[i] = true
      }
    }
    await Promise.all(Array.from({ length: Math.min(REENRICH_APPLY_CONCURRENCY, targets.length) }, worker))
    enriched = applied.filter(Boolean).length
  }

  const lastDoc = snap.docs[snap.docs.length - 1]
  return {
    batch: snap.size,
    candidates: targets.length,
    enriched,
    usage,
    // 滿頁代表可能還有下一批；呼叫端帶 nextCursor 重複呼叫直到 null
    nextCursor: snap.size === REENRICH_SCAN_LIMIT && lastDoc ? lastDoc.id : null,
  }
}
