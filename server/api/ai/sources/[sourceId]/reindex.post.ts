import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { getSource } from '~~/server/utils/ai-knowledge-sources'
import {
  buildEmbeddingText,
  invalidateSourceProductCache,
  KNOWLEDGE_CHUNKS_COLLECTION,
  runIndexOnChunk,
} from '~~/server/utils/ai-knowledge-chunks'
import { recordAiUsage } from '~~/server/utils/ai-usage'

/** 與 bulk-create / reindex-all 一致的保守併發 */
const EMBED_CONCURRENCY = 5

/**
 * POST /api/ai/sources/:sourceId/reindex
 *
 * 只重建「這個來源底下」卡片的 embedding。用途：來源 productName 改動後，
 * 舊 embedding 還帶著舊前綴（或沒有前綴），要重算才生效——過去只有全量 reindex-all
 * （幾百張全重跑），改名一個來源就重算整庫太浪費。
 *
 * 單一來源卡片數受匯入上限（150）約束，一次請求做完（150 × ~300ms / 併發 5 ≈ 9s）。
 * 停用卡跳過（同 reindex-all：不偷偷重新啟用）。冪等，可重跑。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'sources.write')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const db = getDb()
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'source not found' })

  // 來源 productName 的 60s 快取先失效，這輪 reindex 才吃得到剛存的新值
  invalidateSourceProductCache(sourceId)

  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .select('title', 'content', 'questions', 'status')
    .get()

  // 停用的卡跳過：runIndexOnChunk 會把 status 設回 'indexed'，重建不該偷偷重新啟用
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
      // 不帶 workspaceId：逐卡記帳會對同一份月用量文件連打被節流，改累計、最後記一次
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

  if (batchEmbeddingTokens > 0) {
    await recordAiUsage(workspaceId, { buildEmbeddingTokens: batchEmbeddingTokens }, db)
  }

  return {
    total: snap.size,
    skipped: snap.size - docs.length,
    indexed: results.filter(r => r.status === 'indexed').length,
    failed: results.filter(r => r.status === 'failed').length,
    failures: results.filter(r => r.status === 'failed'),
  }
})
