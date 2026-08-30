import { Timestamp } from 'firebase-admin/firestore'
import { getDb } from '~~/server/utils/firebase'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import {
  AI_FEEDBACK_EVENTS_COLLECTION,
  aggregateWrongAnswerMarks,
  isChunkUnfixedSinceMark,
} from '~~/server/utils/ai-feedback-events'
import { KNOWLEDGE_SOURCES_COLLECTION } from '~~/server/utils/ai-knowledge-sources'
import { KNOWLEDGE_CHUNKS_COLLECTION } from '~~/server/utils/ai-knowledge-chunks'
import { KNOWLEDGE_DUP_SCANS_COLLECTION } from '~~/server/utils/ai-duplicate-scan'
import { KNOWLEDGE_SUGGESTIONS_COLLECTION } from '~~/server/utils/ai-knowledge-suggest'
import { isShortChunkContent, needsProductName } from '~~/shared/types/ai-knowledge'
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

/** 被標「答錯」的卡：多帶次數與最後標記時間，清單上要看得出嚴重程度 */
interface WrongAnswerItem extends HealthItem {
  markCount: number
  lastMarkedAtMs: number
}

/** 「答錯」訊號的回看窗口：與建議收件匣的聚類窗口同一把尺（30 天） */
const FEEDBACK_WINDOW_DAYS = 30
/** 單輪最多撈幾筆回饋事件（同 kb-suggest，共用既有的 workspaceId+createdAt 索引） */
const FEEDBACK_SCAN_LIMIT = 100

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

  const feedbackCutoff = Timestamp.fromMillis(Date.now() - FEEDBACK_WINDOW_DAYS * 86_400_000)

  const [sourcesSnap, chunksSnap, indexNames, aliasMap, feedbackSnap, dupScanSnap, pendingSuggestions] = await Promise.all([
    db.collection(KNOWLEDGE_SOURCES_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .limit(300)
      .get(),
    db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      // updatedAt 是「標記之後有沒有人動過這張卡」的依據（見 wrongAnswerChunks）
      // deletedAt：回收桶的卡要排除——⛔select 沒帶欄位的話讀出來恆 undefined，過濾等於沒過濾
      .select('title', 'content', 'status', 'sourceId', 'isOverview', 'expiredAt', 'updatedAt', 'deletedAt')
      .limit(CHUNK_SCAN_LIMIT)
      .get(),
    getWorkspaceProductNames(db, workspaceId),
    getProductAliases(db, workspaceId),
    // 查詢形狀刻意與 kb-suggest 相同（type 在程式裡濾），共用既有的 workspaceId+createdAt 索引，不必再開新的。
    // 缺索引時降級成「少一類體檢」而不是整頁掛掉，但一定要 log——靜默吞掉的話，
    // 客服按的每個「AI 答錯了」都不會出現在工作台，而沒有人會知道。
    db.collection(AI_FEEDBACK_EVENTS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .where('createdAt', '>=', feedbackCutoff)
      .orderBy('createdAt', 'desc')
      .limit(FEEDBACK_SCAN_LIMIT)
      .get()
      .catch((e) => {
        console.warn('[kb-health] feedback query failed (缺 aiFeedbackEvents 複合索引?):', (e as Error)?.message)
        return null
      }),
    // 疑似重複（C-40(c)）：讀排程掃好的結果（單筆文件），這裡零 LLM 費
    db.collection(KNOWLEDGE_DUP_SCANS_COLLECTION).doc(workspaceId).get().catch(() => null),
    /**
     * 建議收件匣的待處理數（D-43 缺口②）：側欄「工作台入口」的數字原本只有
     * KnowledgeSuggestions 元件掛載後才報得出來——選著資料或深連結進頁時元件沒掛載，
     * 「M 個 AI 建議」就整段消失。改由這支供給，畫面狀態不再影響數字。
     * count() 聚合、兩個等值條件走自動索引。⛔查失敗回 null 不回 0（0＝真的沒有）。
     */
    db.collection(KNOWLEDGE_SUGGESTIONS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .where('status', '==', 'pending')
      .count()
      .get()
      .then(agg => agg.data().count)
      .catch((e) => {
        console.warn('[kb-health] pending suggestions count failed:', (e as Error)?.message)
        return null
      }),
  ])

  // reason 一併帶回:清單上直接看得到「為什麼失敗」(最常見是試算表沒分享給服務帳號),
  // 不必逐一點進來源才知道
  const failedSources: Array<{ id: string; name: string; reason: string }> = []
  const outdatedSources: Array<{ id: string; name: string }> = []
  /**
   * 自動偵測對這個網址無效（每輪抓到的內容都不一樣，系統確認不了哪一版才算數）。
   * 一定要跟「同步失敗」分開列：這種來源抓得到內容、狀態也正常，只是**變動偵測形同關閉**——
   * 店家以為系統在顧，其實官網改版了不會有人知道。
   */
  const stalledSources: Array<{ id: string; name: string }> = []
  const noProductSources: Array<{ id: string; name: string; chunkCount: number }> = []
  for (const d of sourcesSnap.docs) {
    const s = d.data() as any
    const name = String(s?.name ?? s?.url ?? '(未命名來源)')
    if (s?.status === 'failed') failedSources.push({ id: d.id, name, reason: String(s?.failureReason ?? '').slice(0, 120) })
    if (s?.outdatedAt) outdatedSources.push({ id: d.id, name })
    if (s?.detectStalledAt) stalledSources.push({ id: d.id, name })
    // 「多卡的檔案來源沒設產品名」= 說明書無主卡事故的源頭;判定與資料列表共用 needsProductName
    if (needsProductName(s)) {
      noProductSources.push({ id: d.id, name, chunkCount: Number(s?.chunkCount ?? 0) })
    }
  }

  /**
   * 客服標「AI 答錯了」的訊號，**按卡聚合**（不是按事件列）。
   *
   * 為什麼按卡：能動手修的單位是那張卡，而「同一張卡被標 3 次」比三筆各自的事件
   * 強得多。聚類成建議要同主題累積、還要等排程（最長 7 天），這裡是不必等的那條路。
   *
   * 沒有 chunkIds 的事件（AI 沒引用到任何卡就答錯）不列：那是知識缺口、沒有卡可修，
   * 已經由建議收件匣涵蓋，列在這裡只會給一條沒有動作可做的死路。
   */
  const markCountByChunk = aggregateWrongAnswerMarks(
    (feedbackSnap?.docs ?? []).map((d) => {
      const e = d.data() as { type?: string; chunkIds?: string[]; createdAt?: any }
      return {
        type: e.type,
        chunkIds: e.chunkIds,
        createdAtMs: typeof e.createdAt?.toMillis === 'function' ? e.createdAt.toMillis() : 0,
      }
    }),
    feedbackCutoff.toMillis(),
  )

  let shortCount = 0
  let failedCount = 0
  let expiredCount = 0
  const shortItems: HealthItem[] = []
  const failedItems: HealthItem[] = []
  const expiredItems: HealthItem[] = []
  const wrongAnswerItems: WrongAnswerItem[] = []
  // 疑似重複的「還活著嗎」名單（C-40(c) 鮮度）：用這批已載入的卡建，零額外讀取
  const liveChunkIds = new Set<string>()
  for (const d of chunksSnap.docs) {
    const c = d.data() as any
    if (c?.deletedAt == null && String(c?.status ?? '') === 'indexed') liveChunkIds.add(d.id)
    if (c?.deletedAt != null) continue // 回收桶的卡不進體檢（索引失敗/過短/到期都不再是它的事）
    const item: HealthItem = {
      id: d.id,
      title: String(c?.title ?? '(無標題)'),
      sourceId: c?.sourceId ?? null,
    }

    /**
     * 被標過答錯、而且**標記之後沒有人動過**這張卡。
     *
     * 「有人改過就自動離開清單」是刻意的：不另外存一份「已處理」狀態，就不會有
     * 「修好了但清單還掛著」的第二種真相。代價是改了卡卻沒真的改對時它會消失——
     * 但那種情況客人會再問、客服會再標一次，訊號自己會回來。
     */
    const marked = markCountByChunk.get(d.id)
    if (marked) {
      const chunkUpdatedMs = typeof c?.updatedAt?.toMillis === 'function' ? c.updatedAt.toMillis() : 0
      if (isChunkUnfixedSinceMark(chunkUpdatedMs, marked)) {
        wrongAnswerItems.push({ ...item, markCount: marked.count, lastMarkedAtMs: marked.lastMarkedAtMs })
      }
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
    stalledSources,
    noProductSources,
    shortChunks: { count: shortCount, items: shortItems },
    failedChunks: { count: failedCount, items: failedItems },
    expiredChunks: { count: expiredCount, items: expiredItems },
    /**
     * 客服標了「AI 答錯了」、而且那張卡至今沒被改過。次數多的排前面——
     * 同一張卡被標好幾次，代表它正在持續答錯客人。
     */
    wrongAnswerChunks: {
      count: wrongAnswerItems.length,
      items: wrongAnswerItems
        .sort((a, b) => b.markCount - a.markCount || b.lastMarkedAtMs - a.lastMarkedAtMs)
        .slice(0, SAMPLE_LIMIT),
      /**
       * 回饋事件撈到上限了＝標記數是低估值。要講出來：不講的話畫面會讀成
       * 「就這幾條」，而實際上可能還有更多被標記過的卡沒被算進來。
       */
      scanTruncated: (feedbackSnap?.size ?? 0) >= FEEDBACK_SCAN_LIMIT,
    },
    /** 卡片掃描是否達到上限(超大知識庫時計數可能低估) */
    chunkScanTruncated: chunksSnap.size >= CHUNK_SCAN_LIMIT,
    /** 建議收件匣待處理數（null＝這次查不到，⛔不等於 0） */
    pendingSuggestions,
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
    /**
     * 疑似重複（C-40(c)）：排程用「向量篩候選 → LLM 判官」掃出來的建議。
     * 只出建議不自動動手——合併/刪除接現成的產品名合併與回收桶，人拍板。
     */
    duplicates: {
      /**
       * 讀取時過濾「兩張卡都還在」（C-40(c) 鮮度）：使用者把 B 卡刪進回收桶之後，
       * 這一組就該立刻從清單消失。不濾的話它會掛到下次掃描為止（排程最長 24 小時），
       * 而「看 B」點過去是一張已刪除的卡——todo 紅點也一直亮著。
       * liveChunkIds 來自上面已經載入的那批卡，不多讀任何一筆。
       */
      items: (Array.isArray((dupScanSnap?.data() as any)?.suggestions)
        ? (dupScanSnap!.data() as any).suggestions
        : []
      ).filter((s: any) => liveChunkIds.has(String(s?.a?.id)) && liveChunkIds.has(String(s?.b?.id))),
      scannedAtMs: Number((dupScanSnap?.data() as any)?.scannedAtMs ?? 0),
    },
  }
})
