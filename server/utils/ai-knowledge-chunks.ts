/**
 * 知識卡 (knowledgeChunks) 的服務層：建立 / 更新 / 重新索引 / 刪除。
 *
 * 設計重點：
 * - Collection 走「top-level + workspaceId 欄位」與既有 autoReplies/conversations 一致
 * - 寫入流程：先寫 pending → 同步呼叫 embed → 成功 indexed / 失敗 failed
 * - 同步寫入時間預期 ~300-500ms（Gemini embed ~200ms + Firestore 2 次寫入）
 * - 排程任務會掃 pending 太久或 failed 的卡重新嘗試
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { embedDocument, estimateTokens } from './gemini'
import { recordAiUsage } from './ai-usage'
import { canonicalProductName, getProductAliases } from './ai-product-alias'
import type { KnowledgeChunkDoc, KnowledgeChunkStatus } from '~~/shared/types/ai-knowledge'

export const KNOWLEDGE_CHUNKS_COLLECTION = 'knowledgeChunks'

/** pending 卡超過此時間就算「卡住」，會被排程任務撿回來重試 */
export const PENDING_STUCK_MS = 5 * 60 * 1000

/** 排程自動重試上限；超過代表非暫時性錯誤（內容問題等），停止無限重試燒 API。手動 reindex 不受限 */
export const MAX_AUTO_RETRIES = 5

export interface ChunkInput {
  title: string
  content: string
  tags: string[]
  /**
   * 「客人常見問法」（LLM 切卡 / normalize 時生成），會一併進 embedding 拉高
   * query-card 相似度。undefined = 呼叫端沒提供（編輯表單沒有此欄位），保留既有值。
   */
  questions?: string[]
  sourceId?: string | null
  /** 是否為列表頁合成的「總覽卡」（見 KnowledgeChunkDoc.isOverview） */
  isOverview?: boolean
}

export function normalizeChunkInput(raw: any): ChunkInput {
  return {
    title: String(raw?.title ?? '').trim(),
    content: String(raw?.content ?? '').trim(),
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String).map((t: string) => t.trim()).filter(Boolean) : [],
    questions: Array.isArray(raw?.questions)
      ? raw.questions.map(String).map((q: string) => q.trim()).filter(Boolean).slice(0, 3)
      : undefined,
    sourceId: raw?.sourceId != null ? String(raw.sourceId).trim() || null : null,
    isOverview: raw?.isOverview === true,
  }
}

export function validateChunkInput(input: ChunkInput): string | null {
  if (!input.title) return '請輸入標題'
  if (!input.content) return '請輸入內容'
  if (input.content.length > 5000) return '內容過長（上限 5000 字）'
  return null
}

/**
 * 組出實際被 embed 的文字：title + 常見問法 + content。
 * - title：切卡規則把核心識別資訊（品名等）放在 title，content 不一定會重複，
 *   只 embed content 會讓「客人用品名提問」撈不到卡。
 * - questions：客人是用問句提問、卡片是敘述句；把「常見問法」一起進向量
 *   能直接拉高 query-card 相似度（比調 grounding 門檻有效）。
 */
export function buildEmbeddingText(title: string, content: string, questions?: string[], productName?: string): string {
  const parts = [
    // 產品名放最前面：切卡常把「這是哪個產品」弄丟（維修卡標題只有「保護代碼EH」），
    // 客人指名品牌問細節（「粒粒安 EH」「威技保固」）就撈不到。來源的正規產品名補在最前，
    // 讓指名檢索命中，且避免同型號跨產品的屬性卡互相蓋掉。
    String(productName || '').trim(),
    String(title || '').trim(),
    ...(questions ?? []).map(q => String(q).trim()).filter(Boolean),
    String(content || '').trim(),
  ]
  return parts.filter(Boolean).join('\n')
}

interface CreateChunkParams extends ChunkInput {
  workspaceId: string
  chunkId: string
  /**
   * 批次呼叫端(bulk-create 等)設 true:跳過每卡一次的 embedding 記帳,
   * 由呼叫端用回傳的 embeddingTokens 加總、整批記一次(避免打爆單一月用量文件)。
   */
  skipUsageRecording?: boolean
}

/**
 * 建立一張知識卡並嘗試索引。回傳最終狀態。
 * 流程：寫 pending → embed → 寫 indexed/failed。失敗不會 throw，會回 failed。
 */
export async function createKnowledgeChunk(
  db: Firestore,
  params: CreateChunkParams,
): Promise<{ id: string; status: KnowledgeChunkStatus; failureReason?: string; embeddingTokens: number }> {
  const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(params.chunkId)
  const now = FieldValue.serverTimestamp()

  await ref.set({
    workspaceId: params.workspaceId,
    title: params.title,
    content: params.content,
    tags: params.tags,
    questions: params.questions ?? [],
    isOverview: params.isOverview === true,
    embedding: null,
    tokens: estimateTokens(params.content),
    status: 'pending',
    sourceId: params.sourceId ?? null,
    lastIndexedAt: null,
    manuallyEditedAt: null,
    createdAt: now,
    updatedAt: now,
  } satisfies Omit<KnowledgeChunkDoc, 'createdAt' | 'updatedAt'> & { createdAt: any; updatedAt: any })

  invalidateTagIndexCache(params.workspaceId)
  return runIndexOnChunk(
    db,
    params.chunkId,
    buildEmbeddingText(params.title, params.content, params.questions),
    params.skipUsageRecording ? undefined : params.workspaceId,
  )
}

interface UpdateChunkParams extends Omit<ChunkInput, 'tags'> {
  chunkId: string
  /**
   * 標籤；undefined = 呼叫端沒提供 → 保留既有標籤（同 questions）。
   * re-sync 補問法時某卡沒補到 tags 就傳 undefined，避免把先前補好的標籤洗成空陣列。
   */
  tags?: string[]
  /** title 或 content 有變就要重新索引（兩者都會進 embedding）；只改標籤可跳過 */
  contentChanged: boolean
  /**
   * 是否為「使用者手動編輯」（非 re-sync 自動覆蓋）。
   * true：寫 manuallyEditedAt = now，之後 re-sync 預設保留此卡
   * false：不動 manuallyEditedAt（給 re-sync 用）
   */
  manualEdit?: boolean
}

/**
 * 更新知識卡。若內容變動則重新索引；只改標題/標籤則保留現有 embedding。
 */
export async function updateKnowledgeChunk(
  db: Firestore,
  params: UpdateChunkParams,
): Promise<{ status: KnowledgeChunkStatus; failureReason?: string }> {
  const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(params.chunkId)
  const now = FieldValue.serverTimestamp()

  // 單次前置讀：status（早退分支回傳用）、既有 questions（沿用 / 比對是否變更）、workspaceId（tag cache 失效用）
  const snap = await ref.get()
  const existing = snap.data() ?? {}
  const existingQuestions: string[] = Array.isArray(existing.questions) ? existing.questions.map(String) : []
  const questions = params.questions ?? existingQuestions
  // questions 也在 embedding 文字裡：有提供且與既有不同，就算 content 沒變也要重新索引，
  // 否則 doc 上的 questions 與向量會永久分歧
  const questionsChanged = params.questions !== undefined
    && JSON.stringify(params.questions) !== JSON.stringify(existingQuestions)
  const needsReindex = params.contentChanged || questionsChanged

  const baseUpdate: Record<string, unknown> = {
    title: params.title,
    content: params.content,
    updatedAt: now,
  }
  // tags / questions 都採「undefined = 保留既有值」：re-sync 補問法時某卡沒補到，
  // 就不要帶欄位，才不會把先前補好的洗成空陣列。
  if (params.tags !== undefined) {
    baseUpdate.tags = params.tags
  }
  if (params.questions !== undefined) {
    baseUpdate.questions = params.questions
  }
  if (params.manualEdit) {
    baseUpdate.manuallyEditedAt = now
  }

  if (typeof existing.workspaceId === 'string') {
    invalidateTagIndexCache(existing.workspaceId)
  }

  if (!needsReindex) {
    await ref.update(baseUpdate)
    return { status: (existing.status as KnowledgeChunkStatus) ?? 'pending' }
  }

  // 內容（或 questions）變動：先標 pending、清掉舊向量，再跑 embed
  await ref.update({
    ...baseUpdate,
    embedding: null,
    tokens: estimateTokens(params.content),
    status: 'pending',
    lastIndexedAt: null,
    failureReason: FieldValue.delete(),
  })

  return runIndexOnChunk(
    db,
    params.chunkId,
    buildEmbeddingText(params.title, params.content, questions),
    typeof existing.workspaceId === 'string' ? existing.workspaceId : undefined,
  )
}

/**
 * 對單一卡跑 embedding。供 create / update / 排程 retry 共用。
 * embeddingText 請用 buildEmbeddingText(title, content, questions) 組出。
 * 不會 throw：embed 失敗就把卡標成 failed 並寫入失敗原因。
 * workspaceId 有帶時把 embedding token 記入月用量（匯入/重建不入帳的話 quota 形同可繞過）。
 * **批次呼叫端（reindex-all、排程 retry）請不要帶 workspaceId**：每卡一寫會對同一份
 * 月用量文件連打（Firestore 單文件 ~1 write/s 建議值），被節流的寫入會靜默漏記——
 * 改用回傳的 embeddingTokens 自行加總、每批記一次。
 */
/**
 * 治本：把「所屬產品的正規名稱」補進每張卡（來源層設 productName，卡片自動繼承）。
 * 這是單一注入點——所有建卡 / 更新 / reindex / retry 都經過 runIndexOnChunk，
 * 故在這裡解析來源 productName、寫進卡片欄位、並前置到 embedding text，一處到位。
 * 依 sourceId 快取，reindex-all 幾百張只讀 ~來源數 次。
 */
const SOURCE_PRODUCT_TTL_MS = 60_000
const sourceProductCache = new Map<string, { expiresAt: number; productName: string }>()

export function invalidateSourceProductCache(sourceId?: string) {
  if (sourceId) sourceProductCache.delete(sourceId)
  else sourceProductCache.clear()
}

async function resolveSourceProductName(db: Firestore, sourceId: string | null): Promise<string> {
  if (!sourceId) return ''
  const cached = sourceProductCache.get(sourceId)
  if (cached && cached.expiresAt > Date.now()) return cached.productName
  let productName = ''
  try {
    const snap = await db.collection('knowledgeSources').doc(sourceId).get()
    productName = String((snap.data() as any)?.productName ?? '').trim()
  }
  catch { /* 讀不到來源就當沒有產品名，不影響索引 */ }
  sourceProductCache.set(sourceId, { expiresAt: Date.now() + SOURCE_PRODUCT_TTL_MS, productName })
  return productName
}

/**
 * 逐卡認領產品：來源層 productName 只在「一來源=一產品」時夠用，但同一產品的卡常散在
 * 「公告 / 商品資訊 / 總覽」等通用來源（productName 空），於是同一台卻併不起來、又反問。
 * 這裡讓「卡片標題自己就寫了品名」的卡直接認領該產品（優先於來源繼承），沒寫的才跟來源走。
 * productNames 是該 workspace 的正規產品名清單（backfill / 建索引時維護）。
 */
export const PRODUCT_NAMES_COLLECTION = 'knowledgeProductIndex'
const wsProductNamesCache = new Map<string, { expiresAt: number; names: string[] }>()

export function invalidateWorkspaceProductNames(workspaceId?: string) {
  if (workspaceId) wsProductNamesCache.delete(workspaceId)
  else wsProductNamesCache.clear()
}

export async function getWorkspaceProductNames(db: Firestore, workspaceId: string): Promise<string[]> {
  const cached = wsProductNamesCache.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.names
  let names: string[] = []
  try {
    const snap = await db.collection(PRODUCT_NAMES_COLLECTION).doc(workspaceId).get()
    const raw = (snap.data() as any)?.names
    if (Array.isArray(raw)) names = raw.map((s: unknown) => String(s).trim()).filter(Boolean)
  }
  catch { /* 沒清單就退回純來源繼承，不影響索引 */ }
  wsProductNamesCache.set(workspaceId, { expiresAt: Date.now() + SOURCE_PRODUCT_TTL_MS, names })
  return names
}

/**
 * 產品索引自動維護（只增不刪）：來源設定 / 匯入時填了 productName 就併進清單。
 * 刻意不做刪除——清單裡有手動種入的別名（同產品多種叫法），無法從來源反推 provenance，
 * 全量重建會把它們洗掉；多出來的舊名對 pickCardProduct 幾乎無害（只影響標題真的含它的卡）。
 * 失敗不擋主流程（索引清單只是加分項）。
 */
export async function addWorkspaceProductName(db: Firestore, workspaceId: string, name: string): Promise<void> {
  const clean = String(name || '').trim()
  if (!clean) return
  try {
    await db.collection(PRODUCT_NAMES_COLLECTION).doc(workspaceId).set(
      { names: FieldValue.arrayUnion(clean) },
      { merge: true },
    )
    invalidateWorkspaceProductNames(workspaceId)
  }
  catch (e) {
    console.warn('[ai-knowledge-chunks] addWorkspaceProductName failed:', e)
  }
}

const normForProductMatch = (s: string) => String(s || '').toLowerCase().replace(/\s+/g, '')

/** 卡標題若含清單裡的某產品名（正規化後子字串、取最長者）→ 用它；否則退回來源繼承的 fallback。 */
export function pickCardProduct(title: string, productNames: string[], fallback: string): string {
  const t = normForProductMatch(title)
  let best = ''
  for (const n of productNames) {
    const nn = normForProductMatch(n)
    if (nn.length >= 3 && t.includes(nn) && n.length > best.length) best = n
  }
  return best || fallback
}

export async function runIndexOnChunk(
  db: Firestore,
  chunkId: string,
  embeddingText: string,
  workspaceId?: string,
): Promise<{ id: string; status: KnowledgeChunkStatus; failureReason?: string; embeddingTokens: number }> {
  const ref = db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(chunkId)
  // 解析並前置產品名：卡標題自己有品名 → 逐卡認領（優先）；否則退回來源層 productName。沒有就維持原樣。
  let productName = ''
  try {
    const cd = (await ref.get()).data() as any
    const sourceProduct = await resolveSourceProductName(db, cd?.sourceId ?? null)
    const names = cd?.workspaceId ? await getWorkspaceProductNames(db, cd.workspaceId) : []
    productName = pickCardProduct(String(cd?.title ?? ''), names, sourceProduct)
    // 別名歸一：同一台機器的不同叫法收斂成正式名，之後建立的卡片一律用同一個字串，
    // 反問分組 / 防混答 / 指名作答才不會把同一台當成兩台。
    if (productName && cd?.workspaceId) {
      const { aliases } = await getProductAliases(db, cd.workspaceId)
      productName = canonicalProductName(productName, aliases)
    }
  }
  catch { /* 讀卡失敗就照原 embeddingText 走 */ }
  const finalText = productName ? `${productName}\n${embeddingText}` : embeddingText
  const embeddingTokens = estimateTokens(finalText)
  try {
    const values = await embedDocument(finalText)
    await ref.update({
      embedding: FieldValue.vector(values),
      productName: productName || FieldValue.delete(),
      status: 'indexed' satisfies KnowledgeChunkStatus,
      lastIndexedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      failureReason: FieldValue.delete(),
      retryCount: FieldValue.delete(),
    })
    if (workspaceId) {
      // fire-and-forget：記帳失敗不影響索引結果（recordAiUsage 內部已吞錯）
      // 建索引 embedding 屬「建置成本」，記到 buildEmbeddingTokens（不進客人對話成本）
      void recordAiUsage(workspaceId, { buildEmbeddingTokens: embeddingTokens }, db)
    }
    return { id: chunkId, status: 'indexed', embeddingTokens }
  }
  catch (err: any) {
    const reason = String(err?.statusMessage || err?.message || 'embed failed').slice(0, 300)
    await ref.update({
      status: 'failed' satisfies KnowledgeChunkStatus,
      failureReason: reason,
      retryCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {})
    return { id: chunkId, status: 'failed', failureReason: reason, embeddingTokens: 0 }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Vector search
// ═══════════════════════════════════════════════════════════════════

export interface SimilarChunk {
  id: string
  title: string
  content: string
  tags: string[]
  /** 0–1，越高越相似（由 cosine distance 換算：max(0, 1 - distance)） */
  similarity: number
  /** 來源 ID（同來源切出來的多 chunk 用此 dedupe） */
  sourceId: string | null
  /** 是否為列表頁合成的「總覽卡」；答題端據此跳過反問澄清 */
  isOverview: boolean
  /** 所屬產品的正規名稱（來源層設定、索引時寫入）；答題 context 用來標明卡片是哪個產品的 */
  productName?: string
}

/**
 * 在指定工作區裡用向量搜尋找最相似的 K 張卡。
 * 用 Firestore Vector Search（findNearest），前置篩選 workspaceId + status='indexed'。
 *
 * 注意：firestore.indexes.json 必須已部署對應的 vector index，否則會 throw。
 */
export async function searchSimilarChunks(
  db: Firestore,
  workspaceId: string,
  queryEmbedding: number[],
  topK = 5,
): Promise<SimilarChunk[]> {
  const baseRef = db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('status', '==', 'indexed')

  // findNearest 接受 number[] 或 VectorValue
  const vectorQuery = baseRef.findNearest({
    vectorField: 'embedding',
    queryVector: FieldValue.vector(queryEmbedding),
    limit: topK,
    distanceMeasure: 'COSINE',
    distanceResultField: '_distance',
  } as any)

  const snap = await vectorQuery.get()
  // 有效期限保險：到期但排程還沒掃到的卡（最壞 10 分鐘空窗）當場排除，不進答題 context
  const nowMs = Date.now()
  return snap.docs
    .filter((doc) => {
      const until = (doc.data() as any)?.activeUntil
      const untilMs = typeof until?.toMillis === 'function' ? until.toMillis() : 0
      return !untilMs || untilMs > nowMs
    })
    .map((doc) => {
      const data = doc.data() as any
      const distance = Number(data?._distance ?? 1)
      const similarity = Math.max(0, 1 - distance)
      return {
        id: doc.id,
        title: String(data?.title ?? ''),
        content: String(data?.content ?? ''),
        tags: Array.isArray(data?.tags) ? data.tags : [],
        similarity,
        sourceId: data?.sourceId ?? null,
        isOverview: data?.isOverview === true,
        productName: String(data?.productName ?? '').trim() || undefined,
      }
    })
}

// ═══════════════════════════════════════════════════════════════════
//  Identifier-tag exact match（向量檢索的精確補位）
//
//  切卡規則把品號 / SKU 放在 tags（例：「品號21070909」），而 embedding 對這類
//  識別碼幾乎沒有訊號 — 客人拿品號提問會 no_grounding。這裡用「英數字串 ≥ 4 碼」
//  的精確比對把這類查詢救回來：query 與 tag 共享同一段識別碼 run 即命中。
//  只比對識別碼 run、不比對一般中文標籤，避免「運費」這類通用詞誤觸發高信心。
// ═══════════════════════════════════════════════════════════════════

/** tag 精確命中視為高信心來源（高於一般 confidence 門檻，會直接過 grounding） */
export const TAG_MATCH_SIMILARITY = 0.95

const TAG_INDEX_TTL_MS = 60_000
const TAG_INDEX_MAX_DOCS = 2000
const tagIndexCache = new Map<string, {
  expiresAt: number
  entries: Array<{ id: string; runs: string[] }>
}>()

export function invalidateTagIndexCache(workspaceId: string) {
  tagIndexCache.delete(workspaceId)
}

/**
 * 抽出識別碼候選：連續英數 ≥ 4 碼且**至少含一個數字**（品號、型號、訂單編號都有數字），統一小寫。
 * 不含數字的 run（'line'、'mail'、'ipad' 這類一般單字）排除——否則 tag「LINE Pay」會讓
 * 任何提到 LINE 的提問以 0.95 信心繞過 grounding / confidence 兩道護欄。
 */
export function extractIdentifierRuns(text: string): string[] {
  return (String(text || '').toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])
    .filter(run => /\d/.test(run))
}

async function loadTagIndex(db: Firestore, workspaceId: string) {
  const cached = tagIndexCache.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.entries

  const snap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('status', '==', 'indexed')
    .select('tags')
    .limit(TAG_INDEX_MAX_DOCS)
    .get()

  const entries = snap.docs
    .map((d) => {
      const tags: string[] = Array.isArray(d.data()?.tags) ? d.data().tags.map(String) : []
      return { id: d.id, runs: tags.flatMap(extractIdentifierRuns) }
    })
    .filter(e => e.runs.length > 0)

  tagIndexCache.set(workspaceId, { expiresAt: Date.now() + TAG_INDEX_TTL_MS, entries })
  return entries
}

/**
 * 用「識別碼精確比對」找卡。query 沒有任何英數 run 時零成本直接回空陣列
 * （純中文提問完全不會多花 Firestore 讀取）。
 */
export async function searchChunksByIdentifierTag(
  db: Firestore,
  workspaceId: string,
  query: string,
  maxHits = 3,
): Promise<SimilarChunk[]> {
  const queryRuns = new Set(extractIdentifierRuns(query))
  if (!queryRuns.size) return []

  const index = await loadTagIndex(db, workspaceId)
  const matchedIds = index
    .filter(e => e.runs.some(r => queryRuns.has(r)))
    .slice(0, maxHits)
    .map(e => e.id)
  if (!matchedIds.length) return []

  const refs = matchedIds.map(id => db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id))
  const snaps = await db.getAll(...refs)
  return snaps
    .filter(s => s.exists && s.data()?.status === 'indexed')
    .map((s) => {
      const data = s.data() as any
      return {
        id: s.id,
        title: String(data?.title ?? ''),
        content: String(data?.content ?? ''),
        tags: Array.isArray(data?.tags) ? data.tags : [],
        similarity: TAG_MATCH_SIMILARITY,
        sourceId: data?.sourceId ?? null,
        isOverview: data?.isOverview === true,
        productName: String(data?.productName ?? '').trim() || undefined,
      }
    })
}

/**
 * 撿出 pending 卡住或 failed 的卡片，逐張重試。供排程任務呼叫。
 * 回傳掃到 / 重試 / 成功 / 失敗 的計數。
 */
export async function retryStuckChunks(
  db: Firestore,
  opts: { maxBatch?: number; pendingStuckMs?: number } = {},
): Promise<{ scanned: number; retried: number; indexed: number; failed: number; skippedPermanent: number }> {
  const maxBatch = opts.maxBatch ?? 20
  const stuckMs = opts.pendingStuckMs ?? PENDING_STUCK_MS
  const cutoff = new Date(Date.now() - stuckMs)

  // 撿 failed。必須在查詢層就排除 retryCount 達上限的卡：只靠撈出後 skip 的話，
  // 全平台累積 ≥maxBatch 張永久失敗卡（一份爛 PDF 就夠）後，每次撈到的都是同一批
  // skippedPermanent，其他租戶的暫時性失敗卡永遠排不進 batch（餓死）。
  // 註：failed 卡必有 retryCount（runIndexOnChunk 失敗路徑 increment 產生），
  // 不會因 Firestore 不等式排除缺欄位文件而漏撈。需要 (status, retryCount) 複合索引。
  const failedSnap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('status', '==', 'failed')
    .where('retryCount', '<', MAX_AUTO_RETRIES)
    .limit(maxBatch)
    .get()

  // 撿 pending 太久
  const pendingSnap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('status', '==', 'pending')
    .where('updatedAt', '<', cutoff)
    .limit(maxBatch)
    .get()

  const docs = [...failedSnap.docs, ...pendingSnap.docs]
  const seen = new Set<string>()
  let indexed = 0
  const tokensByWorkspace = new Map<string, number>()
  let failed = 0
  let skippedPermanent = 0
  for (const doc of docs) {
    if (seen.has(doc.id)) continue
    seen.add(doc.id)
    const data = doc.data()

    // 連續失敗超過上限 → 非暫時性錯誤（內容問題等），停止自動重試。
    // 卡片維持 failed 狀態，使用者手動 reindex 仍可重試（成功會歸零 retryCount）。
    if (Number(data?.retryCount ?? 0) >= MAX_AUTO_RETRIES) {
      skippedPermanent++
      continue
    }

    const content = String(data?.content ?? '')
    if (!content) {
      failed++
      continue
    }
    // 不帶 workspaceId:批次迴圈每卡一寫會打爆單一月用量文件,改累計、迴圈後每 workspace 一寫
    const result = await runIndexOnChunk(db, doc.id, buildEmbeddingText(
      String(data?.title ?? ''),
      content,
      Array.isArray(data?.questions) ? data.questions.map(String) : [],
    ))
    if (result.status === 'indexed') {
      indexed++
      const ws = typeof data?.workspaceId === 'string' ? data.workspaceId : ''
      if (ws) tokensByWorkspace.set(ws, (tokensByWorkspace.get(ws) ?? 0) + result.embeddingTokens)
    }
    else {
      failed++
    }
  }

  // 每個 workspace 記一次帳(排程跨租戶,不能混在同一份文件)
  for (const [ws, tokens] of tokensByWorkspace) {
    if (tokens > 0) await recordAiUsage(ws, { buildEmbeddingTokens: tokens }, db)
  }

  return { scanned: docs.length, retried: seen.size - skippedPermanent, indexed, failed, skippedPermanent }
}
