/**
 * 把一份資料搬進「商品」分組時，產品名是空的就照同組其他資料補上，並讓它重新學習（`C-320`，2026-10-15 拍板 `D-126`①）。
 *
 * 為什麼：AI 只看每份資料的「所屬產品」、不看資料夾。放進「小滑手」資料夾、產品名卻是空的那份，
 * 客人問「小滑手…」時 AI 不知道那幾條是講小滑手的。放進哪一組就該等於告訴 AI 這是哪個商品。
 *
 * 判斷規則（什麼時候補、補成什麼、什麼時候不動）在 shared/knowledge-product-group 的 decideGroupProductName——
 * 舊資料搬家腳本（scripts/migrate-kb-product-groups.mjs）用同一份。⛔ 紅線：不拿資料夾名當產品名、不覆蓋填好的、拿不準不補。
 *
 * 呼叫端：PUT /api/ai/sources/:id 換了資料夾之後（拖進另一個資料夾就是走那支）。
 * 補了之後**當場重新學習**這份的每一條（同 POST /api/ai/sources/:id/reindex 的做法）：
 * 產品名要進到每一條的向量裡才生效，只改來源上的那一格，AI 照舊認不出來。
 */
import type { Firestore } from 'firebase-admin/firestore'
import { getSource, updateSourceSettings, KNOWLEDGE_SOURCES_COLLECTION, type SourceSummary } from './ai-knowledge-sources'
import { KNOWLEDGE_FOLDERS_COLLECTION } from './ai-knowledge-folders'
import {
  buildEmbeddingText,
  invalidateSourceProductCache,
  KNOWLEDGE_CHUNKS_COLLECTION,
  runIndexOnChunk,
} from './ai-knowledge-chunks'
import { canonicalProductName, getProductAliases } from './ai-product-alias'
import { recordAiUsage } from './ai-usage'
import { writeAuditLog } from './audit-log'
import { decideGroupProductName, type GroupProductNameDecision } from '~~/shared/knowledge-product-group'
import type { KnowledgeFolderDoc } from '~~/shared/types/ai-knowledge'

/** 與 reindex / bulk-create 一致的保守併發 */
const EMBED_CONCURRENCY = 5

export interface SourceRelearnResult {
  total: number
  /** 停用的、沒內容的跳過（重新學習不偷偷把停用的打開） */
  skipped: number
  indexed: number
  failed: number
  failures: Array<{ id: string; status: string; failureReason?: string }>
}

/**
 * 讓一份資料底下的每一條重新學習（重算向量，產品名在這一步前置進去）。
 * 跟 POST /api/ai/sources/:id/reindex 是同一套做法（那支的迴圈可以換成呼叫這裡，見 `C-320` 回報）：
 * 停用的跳過（runIndexOnChunk 會把狀態寫回 indexed）、「等你看過」的照樣算向量但狀態不變（runIndexOnChunk 自己守）、
 * 逐條不記帳、最後記一次（同一份月用量文件連打會被節流、靜默漏記）。冪等，可重跑。
 */
export async function relearnSourceChunks(db: Firestore, workspaceId: string, sourceId: string): Promise<SourceRelearnResult> {
  // 來源產品名的 60 秒快取先失效，這一輪才吃得到剛存的新值
  invalidateSourceProductCache(sourceId)
  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('sourceId', '==', sourceId)
    .select('title', 'content', 'questions', 'status')
    .get()
  const docs = snap.docs.filter(d => String(d.data()?.content ?? '').trim() && d.data()?.status !== 'disabled')

  const results: SourceRelearnResult['failures'] = new Array(docs.length)
  let embeddingTokens = 0
  let cursor = 0
  async function worker() {
    while (cursor < docs.length) {
      const idx = cursor++
      const doc = docs[idx]!
      const data = doc.data()
      const r = await runIndexOnChunk(
        db,
        doc.id,
        buildEmbeddingText(
          String(data?.title ?? ''),
          String(data?.content ?? ''),
          Array.isArray(data?.questions) ? data.questions.map(String) : [],
        ),
      )
      if (r.status !== 'failed') embeddingTokens += r.embeddingTokens
      results[idx] = { id: r.id, status: r.status, failureReason: r.failureReason }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, docs.length) }, worker))
  if (embeddingTokens > 0) await recordAiUsage(workspaceId, { buildEmbeddingTokens: embeddingTokens }, db)

  const failures = results.filter(r => r.status === 'failed')
  return {
    total: snap.size,
    skipped: snap.size - docs.length,
    indexed: results.length - failures.length,
    failed: failures.length,
    failures,
  }
}

export type GroupProductNameFillResult =
  | {
    filled: true
    productName: string
    /** 補完之後這份資料的樣子（呼叫端回給畫面用這份，不要回補之前那份） */
    source: SourceSummary
    relearned: SourceRelearnResult
  }
  | {
    filled: false
    /** not-found＝資料不見了（另一個分頁刪了）；其餘同 decideGroupProductName */
    reason: Exclude<GroupProductNameDecision, { action: 'fill' }>['reason'] | 'not-found'
    /** reason＝ambiguous 時，同組有哪幾種產品名（畫面可以拿來問「這份是哪一個？」） */
    names?: string[]
  }

/**
 * 這份資料現在所在的分組若是商品分組、產品名是空的、同組其他資料只有一種產品名 → 補上並重新學習。
 * 其他情況什麼都不寫，回 filled:false 和原因。
 *
 * ⚠️ 要在**資料夾已經換好之後**呼叫（讀的是這份資料現在的 folderId）。
 * ⚠️ 會花 embedding 的錢（一份最多約 150 條），只在真的換了資料夾時呼叫，⛔ 不要每次存設定都打。
 */
export async function fillProductNameFromGroup(
  db: Firestore,
  workspaceId: string,
  sourceId: string,
  /** actor 預設 human（搬資料夾的人）；搬家腳本傳 system、uid 空字串（⛔ 不掛在任何人頭上） */
  ctx: { uid: string; actor?: 'human' | 'system' },
): Promise<GroupProductNameFillResult> {
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) return { filled: false, reason: 'not-found' }
  const folderId = source.data.folderId ?? null

  let group: { general: boolean; name: string } | null = null
  if (folderId) {
    const folderSnap = await db.collection(KNOWLEDGE_FOLDERS_COLLECTION).doc(folderId).get()
    const folder = folderSnap.data() as KnowledgeFolderDoc | undefined
    if (folderSnap.exists && folder?.workspaceId === workspaceId) {
      group = { general: folder.general === true, name: String(folder.name ?? '') }
    }
  }

  // 已經有名字／未分類／通用／型錄 → 不必讀同組其他資料
  const precheck = decideGroupProductName({
    productName: source.data.productName,
    isCatalog: source.data.generateOverview === true,
    isSheet: source.data.type === 'gsheet',
    group,
    siblingProductNames: [],
  })
  if (precheck.action === 'keep') return { filled: false, reason: precheck.reason }

  // 兩個等值條件走自動索引（同 deleteFolderCascade 那一句），不用另建複合索引
  const siblingsSnap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('folderId', '==', folderId)
    .select('productName')
    .get()
  const siblingProductNames = siblingsSnap.docs
    .filter(d => d.id !== sourceId)
    .map(d => String((d.data() as { productName?: string }).productName ?? ''))
  const { aliases } = await getProductAliases(db, workspaceId)
  const decision = decideGroupProductName({
    productName: source.data.productName,
    isCatalog: source.data.generateOverview === true,
    isSheet: source.data.type === 'gsheet',
    group,
    siblingProductNames,
    canonical: n => canonicalProductName(n, aliases),
  })
  if (decision.action !== 'fill') {
    return decision.action === 'ask'
      ? { filled: false, reason: decision.reason, names: decision.names }
      : { filled: false, reason: decision.reason }
  }

  // 跟「所屬產品」那張卡按「儲存並重新學習」同一條路：updateSourceSettings 存名字（也會清快取、把名字併進產品清單），再重新學習
  const updated = await updateSourceSettings(db, workspaceId, sourceId, { productName: decision.productName })
  if (!updated) return { filled: false, reason: 'not-found' }
  const relearned = await relearnSourceChunks(db, workspaceId, sourceId)

  // 稽核（`C-254`）：產品名換掉＝整份資料歸屬的商品換了（答錯台的老毛病），⛔ 失敗條數一定要一起記
  await writeAuditLog({
    workspaceId,
    uid: ctx.uid,
    actor: ctx.actor ?? 'human',
    action: 'source.put',
    targetId: sourceId,
    before: { productName: '' },
    after: { productName: decision.productName, chunkIdsCount: relearned.indexed, failedItemsCount: relearned.failed },
    note: `${String(source.data.name ?? '')}：放進「${group?.name ?? ''}」，所屬產品照同組補成「${decision.productName}」，`
      + `重新學習 ${relearned.indexed} 條${relearned.failed ? `、失敗 ${relearned.failed} 條` : ''}`,
  }, db)

  return { filled: true, productName: decision.productName, source: updated, relearned }
}
