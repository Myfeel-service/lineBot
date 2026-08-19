/**
 * 知識卡 (knowledgeChunks) 的服務層：建立 / 更新 / 重新索引 / 刪除。
 *
 * 設計重點：
 * - Collection 走「top-level + workspaceId 欄位」與既有 autoReplies/conversations 一致
 * - 寫入流程：先寫 pending → 同步呼叫 embed → 成功 indexed / 失敗 failed
 * - 同步寫入時間預期 ~300-500ms（Gemini embed ~200ms + Firestore 2 次寫入）
 * - 排程任務會掃 pending 太久或 failed 的卡重新嘗試
 */
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { embedDocument, estimateTokens, runWithLlmBudget } from './gemini'
import { recordAiUsage } from './ai-usage'
import { canonicalProductName, getProductAliases } from './ai-product-alias'
import type { KnowledgeChunkDoc, KnowledgeChunkStatus } from '~~/shared/types/ai-knowledge'

export const KNOWLEDGE_CHUNKS_COLLECTION = 'knowledgeChunks'

// ═══════════════════════════════════════════════════════════════════
//  回收桶（軟刪除）
//  所有「刪知識卡」的路徑（單卡刪除 / 重新同步的 delete_old / gsheet 同步刪列）
//  一律先進回收桶：status 改 disabled（沿用既有狀態機 → 檢索 / tag 索引 / retry /
//  reindex 的排除全部自動生效）＋ deletedAt / purgeAfter，30 天後排程才真刪。
//  為什麼：健檢抓到五種「資料無聲消失」情境（gsheet 誤刪列 / 分頁讀空 / gid 掉頁 /
//  resync 誤選刪除 / 併發互踩），逐路補防呆是打地鼠——軟刪除把整類後果降級成可還原。
//  ⛔整個來源的「刪除資料」維持真刪（有打字二次確認的強防呆，且還原語意複雜）。
// ═══════════════════════════════════════════════════════════════════

/** 回收桶保留天數；到期由排程 purgeRecycledKnowledge 真刪 */
export const RECYCLE_RETENTION_DAYS = 30

/**
 * 軟刪除的欄位 patch（呼叫端自行 ref.update / batch.update）。
 * existingStatus 給還原用：還原時回到刪除前的狀態（手動停用的卡還原後仍是停用）。
 */
export function buildChunkSoftDeletePatch(existingStatus?: unknown): Record<string, unknown> {
  return {
    status: 'disabled' satisfies KnowledgeChunkStatus,
    // 查詢層過濾用的布林（C-49E）：`deletedAt 不存在` 在 Firestore 表達不了，
    // 而用 count() 聚合算張數必須在查詢層就排除墓碑，否則只能整批讀回來數（150 倍讀取費）。
    isDeleted: true,
    ...(existingStatus ? { statusBeforeDelete: String(existingStatus) } : {}),
    deletedAt: FieldValue.serverTimestamp(),
    purgeAfter: Timestamp.fromMillis(Date.now() + RECYCLE_RETENTION_DAYS * 86_400_000),
    updatedAt: FieldValue.serverTimestamp(),
  }
}

/**
 * 還原時該回到什麼狀態（純函式好測）：
 * - 刪除前是 indexed 但向量已被清掉（刪除後內容曾被動過的邊角）→ pending 讓 retry 重建
 * - 其餘回刪除前的狀態；沒記到刪除前狀態的舊資料 → 有向量當 indexed、沒向量當 pending
 * disabled 刻意原樣保留：刪除前就被店家關掉的卡，還原不等於重新上架。
 */
export function resolveRestoredStatus(statusBeforeDelete: unknown, hasEmbedding: boolean): KnowledgeChunkStatus {
  const prev = String(statusBeforeDelete ?? '')
  if (prev === 'disabled' || prev === 'failed') return prev
  if (prev === 'indexed') return hasEmbedding ? 'indexed' : 'pending'
  if (prev === 'pending') return 'pending'
  return hasEmbedding ? 'indexed' : 'pending'
}

/** 這張卡是否在回收桶（軟刪除狀態）。讀取端排除、寫入端擋操作都用這一把尺。 */
export function isChunkRecycled(data: any): boolean {
  return data?.deletedAt != null
}

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
  // 上限補齊（C-49E）：title 與 tags 都會進 embedding / tag 索引，原本無上限——
  // client 直送 bulk-create 可以用 200 個 tag 撐爆 tag 索引、無限長 title 吃掉整段向量
  if (input.title.length > 200) return '標題過長（上限 200 字）'
  if (input.tags.length > 10) return '標籤太多（上限 10 個）'
  if (input.tags.some(t => t.length > 50)) return '單一標籤過長（上限 50 字）'
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
    isDeleted: false, // 見 buildChunkSoftDeletePatch：查詢層要靠這個欄位排除回收桶
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
  // 否則 doc 上的 questions 與向量會永久分歧。
  // ⛔比對要吃「集合」不吃「逐字順序」（C-49D）：resync 對「未變」卡回填問法時，
  // LLM 這輪只是換個順序或多個空白，逐字比較會讓 100 張未變卡整批白重算 embedding
  // （付錢＋每張各一段索引空窗）。同一批問法換順序對檢索沒有實質差異。
  const qKey = (qs: string[]) => JSON.stringify([...qs.map(q => q.trim()).filter(Boolean)].sort())
  const questionsChanged = params.questions !== undefined
    && qKey(params.questions) !== qKey(existingQuestions)
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

  // 內容（或 questions）變動：先標 pending、清掉舊向量，再跑 embed。
  // ⛔停用卡例外：status 保持 'disabled' 不落 pending——「停用」是店家的意圖、
  // 內容更新不是重新啟用。這裡若寫 pending，下游 runIndexOnChunk 讀到的就不是
  // disabled，守門（停用卡不復活）會失效；被 retry 排程撿走也會直接復活。
  const wasDisabled = existing.status === 'disabled'
  await ref.update({
    ...baseUpdate,
    embedding: null,
    tokens: estimateTokens(params.content),
    status: wasDisabled ? 'disabled' : 'pending',
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
  // 讀一次現況：守門（停用卡不復活）與產品名解析共用這次讀取。
  // 讀失敗時 cd=null → 不守門照原文走（跟舊行為一致；讀都讀不到，embed 多半也會失敗）。
  let cd: any = null
  try {
    cd = (await ref.get()).data()
  }
  catch { /* 讀卡失敗就照原 embeddingText 走 */ }
  /**
   * ⛔守門：停用（disabled）是店家的意圖，重算索引不代表重新啟用。
   * 沒有這條的話，補問法 / gsheet 同步 / 單卡重建索引 / 編輯存檔四條路都會把
   * 停用（含到期下架）的卡無聲寫回 indexed——過期募資價、下架折扣碼直接復活對客人講話，
   * 而 activeUntil 已被到期排程搬走，沒有任何機制會再下架它第二次。
   * 重新啟用只有一條路：settings.post.ts 的「供 AI 使用」開關（不經過這裡）。
   */
  const wasDisabled = cd?.status === 'disabled'
  // 解析並前置產品名：卡標題自己有品名 → 逐卡認領（優先）；否則退回來源層 productName。沒有就維持原樣。
  let productName = ''
  try {
    if (cd) {
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
  }
  catch { /* 產品名解析失敗就照原 embeddingText 走 */ }
  /**
   * embedding 模型輸入上限約 2048 token，超長會被上游截掉或報錯。這裡自己截（C-49D），
   * 但**用估算 token 而不是固定字數**：這是多租戶 SaaS，固定 1800 字對中文剛好、
   * 對英文租戶卻只有約 450 token——等於把模型 3/4 的容量丟掉，同一張卡在改版前後
   * 建出的向量涵蓋範圍還不一樣（排序不一致）。estimateTokens 是既有的同一把尺。
   * 截在前段是刻意的：產品名、標題、客人問法都在最前面，檢索訊號最重的部分保得住。
   */
  const EMBED_TOKEN_LIMIT = 1900 // 留一點餘裕給模型端的計法差異
  const rawText = productName ? `${productName}\n${embeddingText}` : embeddingText
  let finalText = rawText
  if (estimateTokens(rawText) > EMBED_TOKEN_LIMIT) {
    // 依估算比例回推字數，再收斂一次（估算是線性的，一次就夠；保底再砍 5%）
    const ratio = EMBED_TOKEN_LIMIT / estimateTokens(rawText)
    finalText = rawText.slice(0, Math.max(200, Math.floor(rawText.length * ratio * 0.95)))
  }
  const embeddingTokens = estimateTokens(finalText)
  try {
    const values = await embedDocument(finalText)
    await ref.update({
      embedding: FieldValue.vector(values),
      productName: productName || FieldValue.delete(),
      // 停用卡：向量照樣更新（重新啟用時免重算、不會拿到舊向量），但狀態維持 disabled
      status: (wasDisabled ? 'disabled' : 'indexed') satisfies KnowledgeChunkStatus,
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
    return { id: chunkId, status: wasDisabled ? 'disabled' : 'indexed', embeddingTokens }
  }
  catch (err: any) {
    const reason = String(err?.statusMessage || err?.message || 'embed failed').slice(0, 300)
    // 429＝維運額度守門擋下（gemini.ts 出口；Gemini 自己的 429 會被包成 502），不是這張卡的錯：
    // 不耗 retryCount，下月額度恢復後自動重試得回來；耗掉的話 5 輪後永久 failed、額度回來也不自癒。
    const isBudgetBlock = Number(err?.statusCode) === 429
    await ref.update({
      // 停用卡 embed 失敗也不落 failed：落了就會進 retry 佇列，重試成功又寫回 indexed＝復活。
      // 向量可能因此過舊/為空——安全網在 settings.post.ts：啟用時 embedding 為空會擋下並指去「重新索引」。
      status: (wasDisabled ? 'disabled' : 'failed') satisfies KnowledgeChunkStatus,
      failureReason: reason,
      ...(wasDisabled || isBudgetBlock ? {} : { retryCount: FieldValue.increment(1) }),
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {})
    return { id: chunkId, status: wasDisabled ? 'disabled' : 'failed', failureReason: reason, embeddingTokens: 0 }
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
 * 有效期限保險（兩條檢索路共用同一把尺）：到期但排程還沒掃到的卡（最壞 10 分鐘空窗）
 * 當場排除，不進答題 context。向量路與品號 tag 路都要套——tag 命中給 0.95 高信心、
 * 會直接過 grounding/confidence 兩道門，漏了這裡等於過期卡從側門高信心進場。
 */
export function chunkStillActive(data: any, nowMs: number): boolean {
  const until = data?.activeUntil
  const untilMs = typeof until?.toMillis === 'function' ? until.toMillis() : 0
  return !untilMs || untilMs > nowMs
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
    .filter(doc => chunkStillActive(doc.data(), nowMs))
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
  const nowMs = Date.now()
  return snaps
    .filter(s => s.exists && s.data()?.status === 'indexed' && chunkStillActive(s.data(), nowMs))
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
      // 空內容推不動：當場標 failed＋滿額 retryCount 讓它離開佇列。原本只 failed++ 不動文件，
      // updatedAt 永遠不變 → 這張卡每輪都排在「最舊」最前面，把別租戶真正卡住的卡
      // 擠出 limit 名額（隊頭阻塞），每天還白數 144 次。
      await doc.ref.update({
        status: 'failed' satisfies KnowledgeChunkStatus,
        failureReason: '內容為空，無法建立索引',
        retryCount: MAX_AUTO_RETRIES,
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(() => {})
      failed++
      continue
    }
    const ws = typeof data?.workspaceId === 'string' ? data.workspaceId : ''
    // 不帶 workspaceId:批次迴圈每卡一寫會打爆單一月用量文件,改累計、迴圈後每 workspace 一寫。
    // 額度境域（C-45）另外圈:超額的 workspace 這輪跳過（429 不耗 retryCount，下月自動恢復）
    const result = await runWithLlmBudget(ws, () => runIndexOnChunk(db, doc.id, buildEmbeddingText(
      String(data?.title ?? ''),
      content,
      Array.isArray(data?.questions) ? data.questions.map(String) : [],
    )))
    if (result.status === 'indexed') {
      indexed++
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
