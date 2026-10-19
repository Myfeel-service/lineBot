import { getDb } from '~~/server/utils/firebase'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { getSource } from '~~/server/utils/ai-knowledge-sources'
import { alignSourceProductWithGroup, relearnSourceChunks } from '~~/server/utils/ai-knowledge-product-group'
import { writeAuditLog } from '~~/server/utils/audit-log'

/**
 * POST /api/ai/sources/:sourceId/reindex
 *
 * 只重建「這個來源底下」卡片的 embedding。用途：來源 productName 改動後，
 * 舊 embedding 還帶著舊前綴（或沒有前綴），要重算才生效——過去只有全量 reindex-all
 * （幾百張全重跑），改名一個來源就重算整庫太浪費。
 *
 * 單一來源卡片數受匯入上限（150）約束，一次請求做完（150 × ~300ms / 併發 5 ≈ 9s）。
 * 停用卡跳過（同 reindex-all：不偷偷重新啟用）。冪等，可重跑。
 *
 * 迴圈本身在 relearnSourceChunks（`C-320` 搬進商品分組補產品名也用它）：以前兩邊各寫一份，
 * 記帳條件已經分岔——這支只記「indexed」的，「等你看過」的草稿也算了向量、錢花了卻沒記（/code-review 第 14 條）。
 * 現在統一：算了向量就記（沒失敗就算）。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId, uid } = await requireCapability(event, 'sources.write')
  const sourceId = String(getRouterParam(event, 'sourceId') ?? '').trim()
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: 'sourceId required' })

  const db = getDb()
  const source = await getSource(db, sourceId, workspaceId)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'source not found' })

  // `D-127`：先把商品名對齊它所在的分組再學（改組名到一半斷掉、資料上的商品名沒跟上組名的，學這一次就對齊）。
  // `D-129` 起呼叫的是畫面改組名之後一份份學的那一輪；畫面中途關掉的，排程 relearnPendingProductSources 走同一條路補完
  await alignSourceProductWithGroup(db, workspaceId, sourceId)
  const r = await relearnSourceChunks(db, workspaceId, sourceId)

  // 稽核（`C-254`）：會花 embedding 的錢，⛔ 失敗條數一定要一起記
  await writeAuditLog({
    workspaceId,
    uid,
    actor: 'human',
    action: 'source.reindex',
    targetId: sourceId,
    after: { name: String(source.data.name ?? ''), itemsCount: r.total, chunkIdsCount: r.indexed, failedItemsCount: r.failed },
    // `D-129`：店家看得到的字不講「重新學習」
    note: `${String(source.data.name ?? '')}：再學一次，學會 ${r.indexed} 條${r.failed ? `、${r.failed} 條還沒學會（會自己再試）` : ''}`,
  }, db)

  return r
})
