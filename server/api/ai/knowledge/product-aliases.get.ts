import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { getWorkspaceProductNames } from '~~/server/utils/ai-knowledge-chunks'
import { detectAliasCandidates, getProductAliases } from '~~/server/utils/ai-product-alias'

/**
 * GET /api/ai/knowledge/product-aliases
 *
 * 回「已確認的別名對照」＋「系統偵測到、等你確認的候選」。
 * 候選只用手上的資料判斷（來源檔名、既有產品名），不呼叫 LLM，所以很快也不花錢。
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const db = getDb()

  const [srcSnap, indexNames, aliasMap] = await Promise.all([
    db.collection(KNOWLEDGE_SOURCES_COLLECTION).where('workspaceId', '==', workspaceId).limit(300).get(),
    getWorkspaceProductNames(db, workspaceId),
    getProductAliases(db, workspaceId),
  ])

  const sources = srcSnap.docs.map((d) => {
    const s = d.data() as any
    return { name: String(s?.name ?? ''), productName: String(s?.productName ?? '').trim(), type: String(s?.type ?? '') }
  })
  // 產品名池 = 產品索引清單 ∪ 各來源設定的產品名（來源可能設了索引還沒收錄的名字）
  const productNames = [...new Set([...indexNames, ...sources.map(s => s.productName).filter(Boolean)])]

  return {
    // 已確認的對照,以「別名 → 正式名」呈現才看得懂是誰併到誰
    pairs: Object.entries(aliasMap.aliases).map(([aliasKey, canonical]) => ({
      aliasKey,
      alias: aliasMap.aliasLabels[aliasKey] || aliasKey,
      canonical,
    })),
    candidates: detectAliasCandidates({ sources, productNames, aliasMap }),
    productNames,
  }
})
