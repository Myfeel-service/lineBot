import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import {
  buildEmbeddingText,
  KNOWLEDGE_CHUNKS_COLLECTION,
  runIndexOnChunk,
} from '~~/server/utils/ai-knowledge-chunks'
import { recordAiUsage } from '~~/server/utils/ai-usage'

/** 與 bulk-create 一致的保守併發 */
const EMBED_CONCURRENCY = 5

/** 單次請求最多處理幾張卡：300 × ~300ms / 5 併發 ≈ 18 秒，留在請求時限內 */
const BATCH_LIMIT = 300

/**
 * POST /api/ai/knowledge/reindex-all
 * Body: { cursor?: string }（上一批回傳的 nextCursor；首批不帶）
 *
 * 重算工作區知識卡的 embedding，**分批**處理避免大工作區單請求超時。
 * 回傳 nextCursor 非 null 時表示還有下一批，呼叫端帶著 cursor 重複呼叫直到 null。
 *
 * 用途：embedding 組成方式變更後的全量遷移（例：2026-06 起 title + questions 一併進向量）。
 * 查詢用 select() 投影，避免把每張卡的 768 維向量整包拉進記憶體。
 * 冪等，可中斷重跑。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'knowledge.reindexAll')
  const body = await readBody(event).catch(() => ({}))
  const cursor = String(body?.cursor ?? '').trim()

  const db = getDb()
  let q = db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .orderBy('__name__')
    .select('title', 'content', 'questions', 'status')
    .limit(BATCH_LIMIT)
  if (cursor) {
    q = q.startAfter(db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(cursor))
  }
  const snap = await q.get()

  // 停用的卡跳過:runIndexOnChunk 會把 status 設回 'indexed',全量重建不該偷偷重新啟用
  const docs = snap.docs.filter(d => String(d.data()?.content ?? '').trim() && d.data()?.status !== 'disabled')

  type ResultRow = { id: string; status: string; failureReason?: string }
  const results: ResultRow[] = new Array(docs.length)
  let batchEmbeddingTokens = 0

  let cursorIdx = 0
  async function worker() {
    while (cursorIdx < docs.length) {
      const idx = cursorIdx++
      const doc = docs[idx]!
      const data = doc.data()
      // 不帶 workspaceId:300 張/批 × 併發 5 對同一份月用量文件連打會被 Firestore 節流、
      // 靜默漏記;改累計 token、迴圈結束後每批記一次
      const r = await runIndexOnChunk(
        db,
        doc.id,
        buildEmbeddingText(
          String(data?.title ?? ''),
          String(data?.content ?? ''),
          Array.isArray(data?.questions) ? data.questions.map(String) : [],
        ),
      )
      if (r.status === 'indexed') batchEmbeddingTokens += r.embeddingTokens
      results[idx] = { id: r.id, status: r.status, failureReason: r.failureReason }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, docs.length) }, worker))

  // 整批一次記帳(見 worker 內註解)
  if (batchEmbeddingTokens > 0) {
    await recordAiUsage(workspaceId, { buildEmbeddingTokens: batchEmbeddingTokens }, db)
  }

  const indexed = results.filter(r => r.status === 'indexed').length
  const failed = results.filter(r => r.status === 'failed').length
  const lastDoc = snap.docs[snap.docs.length - 1]

  return {
    batch: snap.size,
    skippedEmpty: snap.size - docs.length,
    indexed,
    failed,
    failures: results.filter(r => r.status === 'failed'),
    // 滿頁代表可能還有下一批；呼叫端帶 nextCursor 重複呼叫直到 null
    nextCursor: snap.size === BATCH_LIMIT && lastDoc ? lastDoc.id : null,
  }
})
