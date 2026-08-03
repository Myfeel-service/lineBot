/**
 * 知識缺口建議（建議收件匣）——「系統幫你整理好，你只需要同意」的本體。
 *
 * 資料流：aiHandoffEvents（答不出的客人原話）＋ aiFeedbackEvents（客服標記「AI 答錯了」）
 *   → embedding 聚類成主題 → LLM 擬好整張知識卡草稿 → 寫進 knowledgeSuggestions
 *   → 店家在知識庫頁「採用 / 修改後採用 / 忽略」。
 *
 * 執行模式：cron（run-tasks 每 10 分鐘）每輪最多掃 SCAN_BUDGET_PER_RUN 個 workspace——
 * 聚類要 embed、草擬要 LLM，全部同步跑在單一 API 請求裡會撞閘道逾時（preview-chunks 前例），
 * 所以 UI 的「重新掃描」只是把 workspace 標記為待掃，由下一輪 cron 撿走。
 *
 * 內容誠實原則：LLM 只能使用既有知識卡裡查得到的事實，缺的（價格/時程/規格）一律寫成
 * 「【請填寫：…】」佔位符，採用端會擋下含佔位符的草稿——寧可讓店家補一格，不能編一句。
 */
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { HANDOFF_EVENTS_COLLECTION } from './ai-handoff-events'
import { AI_FEEDBACK_EVENTS_COLLECTION } from './ai-feedback-events'
import { KNOWLEDGE_CHUNKS_COLLECTION } from './ai-knowledge-chunks'
import { embedQuery, generateJson, estimateTokens } from './gemini'
import { recordAiUsage, AI_USAGE_COLLECTION, currentYyyyMm, type UsageDelta } from './ai-usage'
import { notifyKnowledgeSourceEvent } from './ai-handoff-notify'
import { getAiSettings } from './ai-settings'
import { isServiceHoursDnd } from '~~/shared/time'
import { countKnowledgeDraftBlanks, type KnowledgeSuggestionDoc, type KnowledgeSuggestionDraft } from '~~/shared/types/ai-knowledge'

export const KNOWLEDGE_SUGGESTIONS_COLLECTION = 'knowledgeSuggestions'
/** 掃描狀態（cronState 慣例）：{ [workspaceId]: { lastScanAt?: ISO, requestedAt?: ISO } } */
const SCAN_STATE_DOC = 'knowledge-gap-scan'

/** 哪些 handoff 原因算「知識缺口」。llm_error 是故障、quota 是額度、sensitive/user_request/commercial 是政策與意圖，補卡都救不了。 */
const GAP_REASONS = new Set(['no_grounding', 'low_confidence', 'unresolved'])

/** 事件窗口：與建議的「30 天內被問 N 次」口徑一致 */
const EVENT_WINDOW_DAYS = 30
const EVENT_SCAN_LIMIT = 400
/** 最多 embed 幾個去重問句（頻率高的優先）——控制單次掃描的 embedding 成本 */
const MAX_UNIQUE_QUERIES = 150
const EMBED_CONCURRENCY = 4
/**
 * 問句歸為同主題的相似度門檻。query-query 的同義改寫通常 >0.85，
 * 訂 0.83 寧可切太細（同主題出兩條建議）也不要把不同主題混成一張卡。
 */
const CLUSTER_SIM_THRESHOLD = 0.83
/** 候選主題比對「既有建議」的門檻（centroid vs centroid，比句對句寬一點） */
const EXISTING_MATCH_THRESHOLD = 0.8
/** 同主題至少被問幾次才值得變成建議（單一事件由監控頁案例清單涵蓋） */
const MIN_CLUSTER_EVENTS = 2
/**
 * 單次掃描最多草擬幾張新卡。壓到 2 是時間預算：一次 generateJson 最壞會走
 * flash 兩次 + flash-lite fallback 兩次。沒草擬到的主題**仍然會建建議文件**
 * （draft=null），下一輪補草稿——不能默默丟掉,否則收件匣會說「都答得出來」。
 */
const MAX_NEW_DRAFTS_PER_SCAN = 2
/** cron 單輪最多掃幾個 workspace。1 個：這支比 autoapply 更重（embedding + 多次 LLM）。 */
const SCAN_BUDGET_PER_RUN = 1
/** 兩次自動掃描的間隔（手動「重新掃描」另有 MANUAL_SCAN_MIN_GAP_MS 地板） */
const AUTO_SCAN_INTERVAL_DAYS = 7
/**
 * 單一 workspace 掃描的牆鐘預算。cron 端點是 10 分鐘輪、Cloud Scheduler
 * attempt-deadline 300s，而 run-tasks 是 Promise.allSettled（端點耗時＝最慢那項）。
 * 超過就停止草擬、把已完成的成果寫回——分段結束比整輪被掐斷好（被掐斷＝
 * token 已付但什麼都沒留，下輪從頭再付一次）。
 */
const SCAN_TIME_BUDGET_MS = 90_000
/** 草擬一張卡的保守預估：剩餘預算不足就不開始（開始了才逾時＝白付 token） */
const DRAFT_TIME_RESERVE_MS = 30_000
/** 掃描中的租約：逾時被掐斷後由下一輪接手，不會兩個 Lambda 同時掃同一個 workspace */
const SCAN_LEASE_MS = 5 * 60_000
/** 手動「重新掃描」的最小間隔：這支會花 embedding + LLM，不能被連點當成成本槓桿 */
export const MANUAL_SCAN_MIN_GAP_MS = 30 * 60_000
/** 去重比對要撈的既有建議數上限（撞到就 log，靜默截斷會讓已處理的主題被重複推薦） */
const EXISTING_SCAN_LIMIT = 500
/** 處理完（accepted/dismissed）的建議保留天數，靠 expireAt + TTL policy 自動清 */
export const SUGGESTION_RESOLVED_TTL_DAYS = 180

const DRAFT_SYSTEM_INSTRUCTION = `你在幫商家的 LINE 客服 AI 整理知識庫。多位客人問了同一類問題，但 AI 在知識庫裡找不到答案而轉給真人。請把這一類問題整理成一張「知識卡草稿」，讓商家審核後存進知識庫。

規則：
1. 只能使用「既有相關卡片」段落中查得到的事實。客人問到但既有內容沒有的資訊（價格、時程、規格、政策細節），一律寫成佔位符「【請填寫：要補的資訊】」——寧可留空，絕對不要自己編。
2. topic：給後台列表看的主題名，12 字以內，白話（例「運費與到貨時間」）。
3. title：這張卡回答什麼，30 字以內，用商家口吻的敘述，不要用客人的口語問句。
4. content：用可以直接回覆客人的語氣寫，600 字以內；每個佔位符單獨一行。
5. questions：客人可能的問法 3 條（參考樣本問句改寫成口語）。
6. tags：分類標籤最多 3 個。

輸出格式（嚴格 JSON）：{ "topic": string, "title": string, "content": string, "tags": string[], "questions": string[] }`

// ── 小工具 ─────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 讀回 centroid。新資料是 VectorValue（有 toArray()），也容忍純陣列——
 * 讀不出來就當成空陣列跳過比對（比拿半條向量算出「像是對的」相似度安全）。
 */
function readCentroid(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[]
  const v = raw as { toArray?: () => number[] } | null
  if (v && typeof v.toArray === 'function') {
    try {
      return v.toArray()
    }
    catch {
      return []
    }
  }
  return []
}

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

/** 草稿佔位符計數：與前端警示共用 shared 的同一支，不各寫一份（會兜不起來） */
export const countDraftBlanks = countKnowledgeDraftBlanks

// ── 聚類 ───────────────────────────────────────────────────────────

export interface GapItem {
  query: string
  count: number
  latestMs: number
  /** 事件命中的相近卡（chunkId → 次數），草擬時拿最常見的當「既有內容」context */
  chunkFreq: Map<string, number>
}

export interface GapCluster {
  centroid: number[]
  items: GapItem[]
  totalCount: number
  latestMs: number
}

export function buildClusters(items: Array<GapItem & { vector: number[] }>): GapCluster[] {
  const clusters: GapCluster[] = []
  // 頻率高的先開桶：讓最常見的問法成為主題的「代表」
  const sorted = [...items].sort((a, b) => b.count - a.count)
  for (const it of sorted) {
    let best: GapCluster | null = null
    let bestSim = 0
    for (const c of clusters) {
      const sim = cosine(it.vector, c.centroid)
      if (sim >= CLUSTER_SIM_THRESHOLD && sim > bestSim) {
        best = c
        bestSim = sim
      }
    }
    if (best) {
      // running mean（不加權）：centroid 代表「這一類問法」而非最熱門那句
      const n = best.items.length
      best.centroid = best.centroid.map((v, i) => (v * n + it.vector[i]!) / (n + 1))
      best.items.push(it)
      best.totalCount += it.count
      best.latestMs = Math.max(best.latestMs, it.latestMs)
    }
    else {
      clusters.push({ centroid: [...it.vector], items: [it], totalCount: it.count, latestMs: it.latestMs })
    }
  }
  return clusters.sort((a, b) => b.totalCount - a.totalCount)
}

// ── LLM 草擬 ───────────────────────────────────────────────────────

interface DraftContextCard {
  title: string
  content: string
}

async function draftGapCard(
  sampleQueries: string[],
  contextCards: DraftContextCard[],
): Promise<{ topic: string; draft: KnowledgeSuggestionDraft; inputTokens: number; outputTokens: number }> {
  const prompt = [
    '客人問過但 AI 答不出的問題（同一主題的樣本）：',
    ...sampleQueries.slice(0, 6).map(q => `- ${q}`),
    '',
    '既有相關卡片（AI 檢索到但不足以回答的內容；可能為空）：',
    contextCards.length
      ? contextCards.map(c => `〈${c.title}〉\n${c.content}`).join('\n---\n')
      : '（無——知識庫目前完全沒有相關內容，草稿內容請全部用佔位符留給商家填）',
  ].join('\n')

  const { data, inputTokens, outputTokens } = await generateJson<{
    topic?: unknown
    title?: unknown
    content?: unknown
    tags?: unknown
    questions?: unknown
  }>(prompt, {
    systemInstruction: DRAFT_SYSTEM_INSTRUCTION,
    temperature: 0.3,
    maxOutputTokens: 2048,
    // 同 normalizeChunkWithLlm：關 thinking，避免吃掉配額截斷 JSON
    thinkingBudget: 0,
  })

  const title = String(data?.title ?? '').trim().slice(0, 100)
  const content = String(data?.content ?? '').trim().slice(0, 3000)
  if (!title || !content) throw new Error('draft: LLM 回傳的 title/content 為空')

  return {
    topic: String(data?.topic ?? '').trim().slice(0, 20) || title.slice(0, 12),
    draft: {
      title,
      content,
      tags: Array.isArray(data?.tags) ? data.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 3) : [],
      questions: Array.isArray(data?.questions) ? data.questions.map(q => String(q).trim()).filter(Boolean).slice(0, 3) : [],
    },
    inputTokens,
    outputTokens,
  }
}

/**
 * 撈這一群問句最常命中的既有卡當 context，跑一次 LLM 草擬。
 * 不 throw：草擬失敗回 error 字串，呼叫端照樣建建議讓人手寫。
 * token 累加進呼叫端的 usage（草擬屬「知識庫建置」成本）。
 */
async function tryDraft(
  db: Firestore,
  workspaceId: string,
  cluster: GapCluster,
  sampleQueries: string[],
  usage: UsageDelta,
): Promise<{ topic: string; draft: KnowledgeSuggestionDraft | null; error: string }> {
  const topChunkIds = [...cluster.items.reduce((acc, it) => {
    for (const [id, n] of it.chunkFreq) acc.set(id, (acc.get(id) ?? 0) + n)
    return acc
  }, new Map<string, number>()).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => id)

  const contextCards: DraftContextCard[] = []
  if (topChunkIds.length) {
    const chunkDocs = await db.getAll(...topChunkIds.map(id => db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id)))
      .catch(() => [])
    for (const cd of chunkDocs) {
      if (!cd?.exists) continue
      const c = cd.data() as { workspaceId?: string; title?: string; content?: string }
      if (c?.workspaceId !== workspaceId) continue
      contextCards.push({ title: String(c.title ?? ''), content: String(c.content ?? '').slice(0, 600) })
    }
  }

  try {
    const r = await draftGapCard(sampleQueries, contextCards)
    // import* 分項要同時計入 inputTokens/outputTokens（quota 以總量計）——ai-usage.ts 的契約
    usage.importInputTokens = (usage.importInputTokens ?? 0) + r.inputTokens
    usage.importOutputTokens = (usage.importOutputTokens ?? 0) + r.outputTokens
    usage.inputTokens = (usage.inputTokens ?? 0) + r.inputTokens
    usage.outputTokens = (usage.outputTokens ?? 0) + r.outputTokens
    return { topic: r.topic, draft: r.draft, error: '' }
  }
  catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 300)
    console.warn('[kb-suggest] draft failed:', error)
    return { topic: '', draft: null, error }
  }
}

// ── 單一 workspace 掃描 ─────────────────────────────────────────────

export interface GapScanTally {
  events: number
  uniqueQueries: number
  clusters: number
  created: number
  updated: number
  reopened: number
  /** 因時間預算沒草擬到的主題數（建議文件已建，草稿留給下一輪）——不靜默 */
  draftsDeferred: number
  /** 事件或問句撞到掃描上限：eventCount 是取樣值，UI 要說「至少」 */
  sampled: boolean
}

export async function scanWorkspaceKnowledgeGaps(db: Firestore, workspaceId: string): Promise<GapScanTally> {
  const startedAt = Date.now()
  const cutoff = Timestamp.fromMillis(startedAt - EVENT_WINDOW_DAYS * 24 * 3600_000)
  const tally: GapScanTally = {
    events: 0, uniqueQueries: 0, clusters: 0, created: 0, updated: 0, reopened: 0,
    draftsDeferred: 0, sampled: false,
  }

  // 1. 撈事件：handoff 事件流 + 客服「AI 答錯了」標記
  const [handoffSnap, feedbackSnap] = await Promise.all([
    db.collection(HANDOFF_EVENTS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .where('createdAt', '>=', cutoff)
      .orderBy('createdAt', 'desc')
      .limit(EVENT_SCAN_LIMIT)
      .get(),
    db.collection(AI_FEEDBACK_EVENTS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .where('createdAt', '>=', cutoff)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get()
      // 索引還沒 deploy 到這個專案時會 FAILED_PRECONDITION。降級成「少一路訊號」而非整輪失敗，
      // 但一定要 log：靜默吞掉的話，客服按的每個「AI 答錯了」都不進聚類而沒人會知道。
      .catch((e) => {
        console.warn('[kb-suggest] feedback query failed (缺 aiFeedbackEvents 複合索引?):', (e as Error)?.message)
        return null
      }),
  ])
  // 撞到事件上限 → 這個 workspace 的事件比窗口塞得下的多，eventCount 是低估值
  if (handoffSnap.size >= EVENT_SCAN_LIMIT) tally.sampled = true

  // 2. 依「去重後的問句」彙總（同一句被 5 個人問 = count 5，不用 embed 5 次）
  const byQuery = new Map<string, GapItem>()
  const addItem = (rawQuery: unknown, createdAt: unknown, chunkIds: string[]) => {
    const query = String(rawQuery ?? '').trim()
    if (query.length < 4) return // 太短的（「1」「好」）聚不出主題
    const item = byQuery.get(query) ?? { query, count: 0, latestMs: 0, chunkFreq: new Map() }
    item.count++
    item.latestMs = Math.max(item.latestMs, tsToMs(createdAt))
    for (const id of chunkIds) item.chunkFreq.set(id, (item.chunkFreq.get(id) ?? 0) + 1)
    byQuery.set(query, item)
    tally.events++
  }
  for (const d of handoffSnap.docs) {
    const e = d.data() as { query?: string; reason?: string; createdAt?: unknown; sources?: Array<{ chunkId?: string }> }
    if (!GAP_REASONS.has(String(e.reason ?? ''))) continue
    addItem(e.query, e.createdAt, (e.sources ?? []).map(s => String(s?.chunkId ?? '')).filter(Boolean))
  }
  for (const d of feedbackSnap?.docs ?? []) {
    const e = d.data() as { type?: string; query?: string; createdAt?: unknown; chunkIds?: string[] }
    if (e.type !== 'wrong_answer') continue // draft_applied 是採用訊號，不是缺口
    addItem(e.query, e.createdAt, (e.chunkIds ?? []).map(String))
  }

  const allUnique = [...byQuery.values()].sort((a, b) => b.count - a.count)
  const uniqueItems = allUnique.slice(0, MAX_UNIQUE_QUERIES)
  if (allUnique.length > MAX_UNIQUE_QUERIES) tally.sampled = true
  tally.uniqueQueries = uniqueItems.length
  if (!uniqueItems.length) return tally

  // 3. embed + 聚類
  const usage: UsageDelta = {}
  let embedTokens = 0
  const embedded: Array<GapItem & { vector: number[] }> = []
  let cursor = 0
  const worker = async () => {
    while (cursor < uniqueItems.length) {
      const it = uniqueItems[cursor++]!
      try {
        const vector = await embedQuery(it.query)
        embedTokens += estimateTokens(it.query)
        embedded.push({ ...it, vector })
      }
      catch (e) {
        console.warn('[kb-suggest] embed failed:', (e as Error)?.message)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, uniqueItems.length) }, worker))
  if (embedTokens) usage.buildEmbeddingTokens = embedTokens

  const clusters = buildClusters(embedded).filter(c => c.totalCount >= MIN_CLUSTER_EVENTS)
  tally.clusters = clusters.length

  // 4. 與既有建議比對（同 workspace 全狀態；等值查詢免複合索引）。
  // 只取比對與狀態判斷要用的欄位——draft/queries 是這個 collection 最肥的部分，
  // 帶回來只為了算 cosine 是白付流量。
  const existingSnap = await db.collection(KNOWLEDGE_SUGGESTIONS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .select('centroid', 'status', 'eventCount', 'seenCountAtDismiss', 'draft')
    .limit(EXISTING_SCAN_LIMIT)
    .get()
  if (existingSnap.size >= EXISTING_SCAN_LIMIT) {
    // 撞上限＝去重比對只看到一部分,已處理過的主題可能被當成新的重複推薦。
    // 出現這行就要檢查 TTL policy（accepted/dismissed 的 expireAt）有沒有生效。
    console.warn(`[kb-suggest] ${workspaceId} 既有建議超過 ${EXISTING_SCAN_LIMIT} 筆，去重比對可能不完整`)
  }
  const existing = existingSnap.docs.map(d => ({ ref: d.ref, data: d.data() as KnowledgeSuggestionDoc }))

  /** 批次寫回（既有建議的計數更新可能上百筆，逐筆 await 會吃掉時間預算） */
  const pendingWrites: Array<{ ref: FirebaseFirestore.DocumentReference; patch: Record<string, unknown> }> = []

  let draftsLeft = MAX_NEW_DRAFTS_PER_SCAN
  /** 還有時間開始下一張草稿嗎（開始了才逾時＝token 已付卻什麼都沒留） */
  const canDraft = () => draftsLeft > 0 && Date.now() - startedAt < SCAN_TIME_BUDGET_MS - DRAFT_TIME_RESERVE_MS

  for (const cluster of clusters) {
    const queries = cluster.items.map(i => i.query).slice(0, 30)
    const sampleQueries = cluster.items.slice(0, 5).map(i => i.query)
    const lastSeenAt = Timestamp.fromMillis(cluster.latestMs || Date.now())

    let match: (typeof existing)[number] | null = null
    let matchSim = 0
    for (const ex of existing) {
      const centroid = readCentroid(ex.data.centroid)
      if (!centroid.length) continue
      const sim = cosine(cluster.centroid, centroid)
      if (sim >= EXISTING_MATCH_THRESHOLD && sim > matchSim) {
        match = ex
        matchSim = sim
      }
    }

    if (match) {
      const status = match.data.status
      if (status === 'accepted') continue // 已補過卡；窗口內的舊事件不用再吵（真的還答不出會累積成新事件，下輪窗口自然再現）
      if (status === 'dismissed') {
        const baseline = Number(match.data.seenCountAtDismiss ?? 0) || 1
        if (cluster.totalCount >= baseline * 2) {
          // 忽略過但事件數翻倍＝問題持續惡化，重新浮出（重回 pending 就不該再被 TTL 清掉）
          pendingWrites.push({
            ref: match.ref,
            patch: {
              status: 'pending',
              eventCount: cluster.totalCount,
              sampled: tally.sampled,
              queries,
              sampleQueries,
              lastSeenAt,
              expireAt: FieldValue.delete(),
              updatedAt: FieldValue.serverTimestamp(),
            },
          })
          tally.reopened++
        }
        continue
      }

      // pending：更新計數與樣本，讓「30 天內被問 N 次」保持新鮮。
      // 上一輪因時間預算沒草擬到的（draft=null 且沒失敗原因），這輪補上。
      const patch: Record<string, unknown> = {
        eventCount: cluster.totalCount,
        sampled: tally.sampled,
        queries,
        sampleQueries,
        lastSeenAt,
        updatedAt: FieldValue.serverTimestamp(),
      }
      if (!match.data.draft && canDraft()) {
        draftsLeft--
        const r = await tryDraft(db, workspaceId, cluster, sampleQueries, usage)
        if (r.draft) {
          patch.draft = r.draft
          patch.blanksCount = countDraftBlanks(r.draft.content)
          patch.draftError = FieldValue.delete()
        }
        else if (r.error) {
          patch.draftError = r.error
        }
      }
      pendingWrites.push({ ref: match.ref, patch })
      tally.updated++
      continue
    }

    // 5. 新主題。草稿有預算上限,但**建議文件一定要建**——沒建就等於默默丟掉一個缺口,
    // 收件匣還會顯示「都答得出來」。沒草擬到的下一輪補（見上面 pending 分支）。
    let topic = sampleQueries[0]?.slice(0, 12) ?? '(未命名主題)'
    let draft: KnowledgeSuggestionDraft | null = null
    let draftError = ''
    if (canDraft()) {
      draftsLeft--
      const r = await tryDraft(db, workspaceId, cluster, sampleQueries, usage)
      if (r.draft) {
        topic = r.topic || topic
        draft = r.draft
      }
      else {
        draftError = r.error
      }
    }
    else {
      tally.draftsDeferred++
    }

    await db.collection(KNOWLEDGE_SUGGESTIONS_COLLECTION).add({
      workspaceId,
      status: 'pending',
      topic,
      sampleQueries,
      queries,
      eventCount: cluster.totalCount,
      sampled: tally.sampled,
      // 存成 VectorValue（同知識卡 embedding 慣例）:純陣列會被自動建單欄索引,
      // 768 維 = 每份文件上千筆用不到的索引條目。
      centroid: FieldValue.vector(cluster.centroid),
      draft,
      blanksCount: draft ? countDraftBlanks(draft.content) : 0,
      ...(draftError ? { draftError } : {}),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastSeenAt,
    })
    tally.created++
  }

  // 批次寫回既有建議的更新（可能上百筆；Firestore batch 上限 500）
  for (let i = 0; i < pendingWrites.length; i += 400) {
    const batch = db.batch()
    for (const w of pendingWrites.slice(i, i + 400)) batch.set(w.ref, w.patch, { merge: true })
    await batch.commit()
  }

  if (Object.keys(usage).length) await recordAiUsage(workspaceId, usage, db)
  if (tally.draftsDeferred) {
    console.log(`[kb-suggest] ${workspaceId}: ${tally.draftsDeferred} 個主題因時間預算未草擬，下一輪補`)
  }
  return tally
}

// ── 掃描排程（cron 入口）與狀態 ────────────────────────────────────

interface ScanStateEntry {
  lastScanAt?: string
  requestedAt?: string
  /** 上次掃描失敗的時間（成功時清掉）：讓 UI 說得出「掃了但失敗」而不是假裝成功 */
  lastErrorAt?: string
  lastError?: string
  /** 掃描中的租約到期時間（ISO）：被閘道掐斷後由下一輪接手，不重複掃 */
  leaseUntil?: string
}

/** 整體「下次到期」時間（ISO）：沒到期就 1 讀早退，不做昂貴的候選探索 */
const NEXT_DUE_KEY = '__nextDueAt'

export async function getGapScanState(db: Firestore, workspaceId: string): Promise<{
  lastScanAtMs: number
  requested: boolean
  lastError: string
}> {
  const doc = await db.collection('cronState').doc(SCAN_STATE_DOC).get()
  const entry = ((doc.data() ?? {}) as Record<string, ScanStateEntry>)[workspaceId] ?? {}
  const lastScanAtMs = entry.lastScanAt ? Date.parse(entry.lastScanAt) || 0 : 0
  const requestedMs = entry.requestedAt ? Date.parse(entry.requestedAt) || 0 : 0
  const errorAtMs = entry.lastErrorAt ? Date.parse(entry.lastErrorAt) || 0 : 0
  return {
    lastScanAtMs,
    requested: requestedMs > lastScanAtMs,
    // 只有「比上次成功掃描更新」的錯誤才算還沒解決
    lastError: errorAtMs > lastScanAtMs ? String(entry.lastError ?? '掃描失敗') : '',
  }
}

/**
 * UI「重新掃描」：只做標記，由 cron（10 分鐘輪）撿走——同步跑會撞閘道逾時。
 * 有最小間隔地板：這支會花 embedding + LLM，連點就是成本槓桿。
 * 回傳 false = 太頻繁、這次沒排進去。
 */
export async function requestGapScan(db: Firestore, workspaceId: string): Promise<boolean> {
  const stateRef = db.collection('cronState').doc(SCAN_STATE_DOC)
  const state = ((await stateRef.get()).data() ?? {}) as Record<string, ScanStateEntry>
  const entry = state[workspaceId] ?? {}
  const lastMs = Math.max(
    entry.lastScanAt ? Date.parse(entry.lastScanAt) || 0 : 0,
    entry.requestedAt ? Date.parse(entry.requestedAt) || 0 : 0,
  )
  if (lastMs && Date.now() - lastMs < MANUAL_SCAN_MIN_GAP_MS) return false

  const nowIso = new Date().toISOString()
  await stateRef.set({
    [workspaceId]: { requestedAt: nowIso },
    // 手動要求要能立刻被下一輪撿到，不受整體到期時間擋住
    [NEXT_DUE_KEY]: nowIso,
  }, { merge: true })
  return true
}

export async function scanKnowledgeGaps(db: Firestore) {
  const stateRef = db.collection('cronState').doc(SCAN_STATE_DOC)
  const state = ((await stateRef.get()).data() ?? {}) as Record<string, ScanStateEntry | string>
  const nowMs = Date.now()

  // 便宜早退：候選探索要掃事件流 + aiUsage（幾百筆讀）。掃描間隔是「天」等級，
  // 但 cron 是 10 分鐘輪——不早退的話 >99% 的輪次都在為零結果付讀取費。
  const nextDueAt = typeof state[NEXT_DUE_KEY] === 'string' ? Date.parse(state[NEXT_DUE_KEY] as string) || 0 : 0
  if (nextDueAt && nowMs < nextDueAt) return { skipped: 'not-due' as const }

  // 候選 workspace：
  //   (a) 最近 500 筆 handoff 事件出現過的（只取 workspaceId，不整份拉回）
  //   (b) 本月有 AI 活動的（aiUsage 一個 workspace 一個月一顆 doc，很小）
  // 只靠 (a) 會讓高流量 OA 把低流量 OA 擠出視野——被擠掉的那個從此不再被掃，
  // 明明有新的答不出問題也生不出建議。(b) 讓候選集合與流量無關。
  const [recentSnap, usageSnap] = await Promise.all([
    db.collection(HANDOFF_EVENTS_COLLECTION)
      .orderBy('createdAt', 'desc')
      .select('workspaceId')
      .limit(500)
      .get(),
    db.collection(AI_USAGE_COLLECTION)
      .where('period', '==', currentYyyyMm())
      .select('workspaceId')
      .limit(300)
      .get()
      .catch(() => null),
  ])
  const withEvents = new Set<string>()
  for (const d of [...recentSnap.docs, ...(usageSnap?.docs ?? [])]) {
    const ws = String((d.data() as { workspaceId?: string }).workspaceId ?? '')
    if (ws) withEvents.add(ws)
  }

  const entryOf = (ws: string): ScanStateEntry => {
    const raw = state[ws]
    return raw && typeof raw === 'object' ? raw : {}
  }

  const candidates = [...new Set([...withEvents, ...Object.keys(state).filter(k => k !== NEXT_DUE_KEY)])]
    .map((ws) => {
      const entry = entryOf(ws)
      const lastMs = entry.lastScanAt ? Date.parse(entry.lastScanAt) || 0 : 0
      const requested = !!entry.requestedAt && (Date.parse(entry.requestedAt) || 0) > lastMs
      const stale = nowMs - lastMs > AUTO_SCAN_INTERVAL_DAYS * 24 * 3600_000
      // 租約還沒過期＝另一個 Lambda 正在掃（或剛被掐斷還在保護期），跳過
      const leased = !!entry.leaseUntil && (Date.parse(entry.leaseUntil) || 0) > nowMs
      return { ws, lastMs, requested, due: !leased && (requested || (stale && withEvents.has(ws))) }
    })
    .filter(c => c.due)
    // 手動要求的優先，其餘照「最久沒掃」
    .sort((a, b) => Number(b.requested) - Number(a.requested) || a.lastMs - b.lastMs)

  const picked = candidates.slice(0, SCAN_BUDGET_PER_RUN)
  if (!picked.length) {
    // 沒事做 → 把下次探索推遠一點（有人手動要求時 requestGapScan 會把它拉回現在）
    await stateRef.set({ [NEXT_DUE_KEY]: new Date(nowMs + 6 * 3600_000).toISOString() }, { merge: true })
    return { scanned: 0 }
  }

  const results: Record<string, GapScanTally | { error: string }> = {}
  for (const c of picked) {
    // 先搶租約再掃：同一個 workspace 不會被兩個 Lambda 同時掃（重複 embedding + 重複建議）
    await stateRef.set(
      { [c.ws]: { leaseUntil: new Date(Date.now() + SCAN_LEASE_MS).toISOString() } },
      { merge: true },
    )
    try {
      results[c.ws] = await scanWorkspaceKnowledgeGaps(db, c.ws)
      await stateRef.set({
        [c.ws]: {
          lastScanAt: new Date().toISOString(),
          leaseUntil: FieldValue.delete(),
          lastErrorAt: FieldValue.delete(),
          lastError: FieldValue.delete(),
        },
      }, { merge: true })
    }
    catch (e) {
      const error = String((e as Error)?.message ?? e).slice(0, 300)
      results[c.ws] = { error }
      console.error(`[kb-suggest] scan ${c.ws} failed:`, e)
      // 失敗**不寫 lastScanAt**：否則 UI 會顯示「剛剛掃過」卻沒有任何建議，
      // 而且「重新掃描」按鈕會因為 requested 被清掉而消失（使用者無從重試）。
      await stateRef.set({
        [c.ws]: { lastErrorAt: new Date().toISOString(), lastError: error, leaseUntil: FieldValue.delete() },
      }, { merge: true })
    }
  }
  // 還有排隊中的候選就讓下一輪立刻接著跑，否則推遠
  const moreQueued = candidates.length > picked.length
  await stateRef.set(
    { [NEXT_DUE_KEY]: new Date(Date.now() + (moreQueued ? 0 : 6 * 3600_000)).toISOString() },
    { merge: true },
  )
  console.log('[ai:knowledge-gap-scan]', results)
  return { scanned: picked.length, results }
}

// ── 採用後自動銷案 ─────────────────────────────────────────────────

/**
 * 把監控頁「轉真人案例」中，問句屬於這批 queries 的對話標為已處理。
 * 補完卡不用再回監控頁逐筆按「已處理」——閉環在採用當下收掉。
 */
export async function resolveHandoffsByQueries(db: Firestore, workspaceId: string, queries: string[]): Promise<number> {
  const set = new Set(queries.map(q => String(q).trim()).filter(Boolean))
  if (!set.size) return 0

  // 與 /api/ai/usage/handoffs 同一組查詢（複合索引已存在）
  const snap = await db.collection('conversations')
    .where('workspaceId', '==', workspaceId)
    .where('aiMeta.lastDecision', '==', 'handoff')
    .orderBy('aiMeta.updatedAt', 'desc')
    .limit(150)
    .get()

  const batch = db.batch()
  let resolved = 0
  for (const d of snap.docs) {
    const meta = (d.data() as {
      aiMeta?: { lastQuery?: string; lastHandoffReason?: string; updatedAt?: unknown; handoffResolvedAt?: unknown }
    }).aiMeta
    if (!meta) continue
    const resolvedMs = tsToMs(meta.handoffResolvedAt)
    if (resolvedMs > 0 && resolvedMs >= tsToMs(meta.updatedAt)) continue // 已處理
    // 只銷「補卡救得了」的那幾種原因。業務洽詢/敏感主題/客人主動要真人即使問句一樣，
    // 也還是要真人處理——補了卡就把人家的待辦悄悄關掉是錯的。
    if (!GAP_REASONS.has(String(meta.lastHandoffReason ?? ''))) continue
    if (!set.has(String(meta.lastQuery ?? '').trim())) continue
    batch.set(d.ref, { aiMeta: { handoffResolvedAt: FieldValue.serverTimestamp() } }, { merge: true })
    resolved++
  }
  if (resolved) await batch.commit()
  return resolved
}

// ── 週報 digest ────────────────────────────────────────────────────

const DIGEST_STATE_DOC = 'knowledge-gap-digest'
const DIGEST_WEEKDAY_TAIPEI = 1 // 週一
const DIGEST_HOUR_TAIPEI = 9

/**
 * 每週一早上把「待處理的知識缺口建議」摘要推給轉真人通知名單。
 * 與 dailyBacklogDigest 同一套防重（cronState 記上次發送日）；沒有建議就不打擾。
 */
/** 整體「這一天跑過了」的旗標：週一整天每 10 分鐘掃 300 筆是白付的 */
const DIGEST_DONE_KEY = '__lastRunDate'
const DIGEST_SCAN_LIMIT = 300

export async function weeklyKnowledgeGapDigest(db: Firestore) {
  const taipeiNow = new Date(Date.now() + 8 * 3600_000)
  if (taipeiNow.getUTCDay() !== DIGEST_WEEKDAY_TAIPEI) return { skipped: 'not-monday' as const }
  if (taipeiNow.getUTCHours() < DIGEST_HOUR_TAIPEI) return { skipped: 'before-hour' as const }
  const today = taipeiNow.toISOString().slice(0, 10)

  const stateRef = db.collection('cronState').doc(DIGEST_STATE_DOC)
  const state = ((await stateRef.get()).data() ?? {}) as Record<string, string>
  // 這一天已經跑完 → 1 讀早退。少了這道,週一 09:00 之後每 10 分鐘都會再掃一次 300 筆。
  if (state[DIGEST_DONE_KEY] === today) return { skipped: 'already-ran-today' as const }

  const snap = await db.collection(KNOWLEDGE_SUGGESTIONS_COLLECTION)
    .where('status', '==', 'pending')
    .limit(DIGEST_SCAN_LIMIT)
    .get()
  if (snap.size >= DIGEST_SCAN_LIMIT) {
    // 撞上限＝某些 workspace 這週可能不會收到週報（跨租戶共用這個上限）
    console.warn(`[kb-suggest] digest 撈到 ${snap.size} 筆待處理建議（上限），部分工作區本週可能漏發`)
  }

  const byWs = new Map<string, Array<{ topic: string; eventCount: number; sampled: boolean }>>()
  for (const d of snap.docs) {
    const s = d.data() as KnowledgeSuggestionDoc
    const ws = String(s.workspaceId ?? '')
    if (!ws) continue
    const list = byWs.get(ws) ?? []
    list.push({
      topic: String(s.topic ?? '(未命名主題)'),
      eventCount: Number(s.eventCount ?? 0),
      sampled: s.sampled === true,
    })
    byWs.set(ws, list)
  }

  let notified = 0
  const statePatch: Record<string, string> = { [DIGEST_DONE_KEY]: today }
  for (const [ws, list] of byWs) {
    if (state[ws] === today) continue // 今天發過（週一整天只發一次）
    // 通知關掉 / 勿擾時段內就別蓋「今天發過」的章——蓋了之後這一週就永遠補不回來
    // （dailyBacklogDigest 也是先檢查再蓋章）。
    const settings = await getAiSettings(ws, db).catch(() => null)
    const cfg = settings?.handoffNotify
    if (!cfg?.enabled || !cfg.lineUserIds.length) continue
    if (isServiceHoursDnd(settings?.serviceHours)) continue

    const top = list.sort((a, b) => b.eventCount - a.eventCount).slice(0, 3)
    const lines = [
      '📚 AI 知識庫週報',
      '最近客人問了、但 AI 答不出來的主題：',
      ...top.map((t, i) => `${i + 1}. ${t.topic}（30 天內${t.sampled ? '至少' : ''} ${t.eventCount} 次）`),
      ...(list.length > top.length ? [`…等共 ${list.length} 個主題`] : []),
      '草稿已幫你擬好，到後台「知識庫」審一眼、按「採用」AI 就學會了。',
    ]
    await notifyKnowledgeSourceEvent(ws, lines.join('\n')).catch(e =>
      console.warn('[kb-suggest] digest push failed:', (e as Error)?.message))
    statePatch[ws] = today
    notified++
  }
  await stateRef.set(statePatch, { merge: true })
  return { workspacesNotified: notified, pendingSuggestions: snap.size }
}
