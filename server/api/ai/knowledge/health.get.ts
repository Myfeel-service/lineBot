import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { isShortChunkContent } from '~~/shared/types/ai-knowledge'
import { getWorkspaceProductNames } from '~~/server/utils/ai-knowledge-chunks'
import { detectAliasCandidates, getProductAliases } from '~~/server/utils/ai-product-alias'

/** 掃描上限:健檢是彙總訊號,不是完整報表;超大知識庫掃前 N 張已足以暴露問題 */
const CHUNK_SCAN_LIMIT = 1500
/** 每類最多回幾筆樣本(給「點了直接修」的清單;count 仍是全掃描的計數) */
const SAMPLE_LIMIT = 30

interface HealthItem {
  id: string
  title: string
  sourceId: string | null
}

/**
 * GET /api/ai/knowledge/health
 *
 * 知識庫健康檢查列(P2-3):把 7/31 稽核靠工程師手動翻出來的問題變成常駐體檢。
 * 一次回六類警訊的計數+樣本,來源頁頂部顯示彙總、點了直接列出來修:
 *   來源層——同步失敗 / 偵測到變動未處理 / 多卡檔案未設產品名(無主卡事故源頭)
 *   卡片層——內容過短 / 索引失敗 / 已過期停用
 */
export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
  const db = getDb()

  const [sourcesSnap, chunksSnap, indexNames, aliasMap] = await Promise.all([
    db.collection(KNOWLEDGE_SOURCES_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .limit(300)
      .get(),
    db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .select('title', 'content', 'status', 'sourceId', 'isOverview', 'expiredAt')
      .limit(CHUNK_SCAN_LIMIT)
      .get(),
    getWorkspaceProductNames(db, workspaceId),
    getProductAliases(db, workspaceId),
  ])

  // reason 一併帶回:清單上直接看得到「為什麼失敗」(最常見是試算表沒分享給服務帳號),
  // 不必逐一點進來源才知道
  const failedSources: Array<{ id: string; name: string; reason: string }> = []
  const outdatedSources: Array<{ id: string; name: string }> = []
  const noProductSources: Array<{ id: string; name: string; chunkCount: number }> = []
  for (const d of sourcesSnap.docs) {
    const s = d.data() as any
    const name = String(s?.name ?? s?.url ?? '(未命名來源)')
    if (s?.status === 'failed') failedSources.push({ id: d.id, name, reason: String(s?.failureReason ?? '').slice(0, 120) })
    if (s?.outdatedAt) outdatedSources.push({ id: d.id, name })
    // 「多卡的檔案來源沒設產品名」= 說明書無主卡事故的源頭;FAQ/公告類多為 gsheet/url,不誤傷
    if (s?.type === 'file' && !String(s?.productName ?? '').trim() && !s?.generateOverview && Number(s?.chunkCount ?? 0) >= 5) {
      noProductSources.push({ id: d.id, name, chunkCount: Number(s?.chunkCount ?? 0) })
    }
  }

  let shortCount = 0
  let failedCount = 0
  let expiredCount = 0
  const shortItems: HealthItem[] = []
  const failedItems: HealthItem[] = []
  const expiredItems: HealthItem[] = []
  for (const d of chunksSnap.docs) {
    const c = d.data() as any
    const item: HealthItem = {
      id: d.id,
      title: String(c?.title ?? '(無標題)'),
      sourceId: c?.sourceId ?? null,
    }
    const status = String(c?.status ?? '')
    if (status === 'failed') {
      failedCount++
      if (failedItems.length < SAMPLE_LIMIT) failedItems.push(item)
    }
    else if (status === 'disabled' && c?.expiredAt) {
      expiredCount++
      if (expiredItems.length < SAMPLE_LIMIT) expiredItems.push(item)
    }
    // 過短只看啟用中的卡(停用的不影響答題);總覽卡另有合成流程不算。
    // 判定用 shared 的共用函式,與來源頁逐卡警示同一把尺(不然兩邊數字會對不起來)
    else if (status !== 'disabled' && !c?.isOverview && isShortChunkContent(c?.content)) {
      shortCount++
      if (shortItems.length < SAMPLE_LIMIT) shortItems.push(item)
    }
  }

  return {
    failedSources,
    outdatedSources,
    noProductSources,
    shortChunks: { count: shortCount, items: shortItems },
    failedChunks: { count: failedCount, items: failedItems },
    expiredChunks: { count: expiredCount, items: expiredItems },
    /** 卡片掃描是否達到上限(超大知識庫時計數可能低估) */
    chunkScanTruncated: chunksSnap.size >= CHUNK_SCAN_LIMIT,
    /**
     * 待確認的產品別名組數。放在體檢裡回:這支本來就撈了全部來源,不必為了工具列一個
     * 數字再打一支 API;更重要的是——不主動顯示的話,使用者永遠沒有理由去點那顆按鈕,
     * 整個別名功能等於不存在。
     */
    aliasCandidateCount: detectAliasCandidates({
      sources: sourcesSnap.docs.map((d) => {
        const s = d.data() as any
        return { name: String(s?.name ?? ''), productName: String(s?.productName ?? '').trim(), type: String(s?.type ?? '') }
      }),
      productNames: [...new Set([
        ...indexNames,
        ...sourcesSnap.docs.map(d => String((d.data() as any)?.productName ?? '').trim()).filter(Boolean),
      ])],
      aliasMap,
    }).length,
  }
})
