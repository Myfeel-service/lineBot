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
import { getMaintenanceBudgetStatus, recordAiUsage } from './ai-usage'
import { canonicalProductName, getProductAliases, normalizeProductName } from './ai-product-alias'
import { writeAuditLog } from './audit-log'
import type { KnowledgeChunkDoc, KnowledgeChunkStatus } from '~~/shared/types/ai-knowledge'
import { KNOWLEDGE_MAX_AUTO_RETRIES } from '~~/shared/knowledge-relearn'

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
  // ⛔ draft（等你看過）還原後仍是 draft：還原＝撤銷刪除，不等於點頭（`C-250`③）
  if (prev === 'disabled' || prev === 'failed' || prev === 'draft') return prev
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

/**
 * 排程自動重試上限；超過代表非暫時性錯誤（內容問題等），停止無限重試燒 API。手動 reindex 不受限。
 * 數字放在 shared（`D-129`）：畫面要照同一個數判斷「系統還會再試」還是「試完了、這時才給按鈕」。
 */
export const MAX_AUTO_RETRIES = KNOWLEDGE_MAX_AUTO_RETRIES

/**
 * 排程自動重試一輪的份量（`D-129`，2026-10-19）。以前一輪只撿全平台 20 條、一條條排隊打：
 * 10-16 搬家 281 條失敗要 15 輪＝2 個半小時才補完，那段時間客人問到那幾條都找不到。
 *
 * 為什麼是這幾個數（費用、速率、時限三邊都要過）：
 *  · 費用：放寬份量**不會多花錢**——每條最多自動試 5 次（MAX_AUTO_RETRIES），總花費只跟失敗條數有關，份量只決定多快補完。
 *    一條約 300～1,900 token，gemini-embedding-001 每百萬 token 約 US$0.15：一輪 100 條最多約 US$0.03。
 *  · 速率：一輪最多打 100 次（failed、卡住的 pending 合計）、同時 5 條（跟加入知識、整份重學同一個併發）。
 *    ⚠️ 客人問問題也走同一個模型（embedQuery）——撞到每分鐘上限，壞的是回答客人。Gemini 付費第一級公開的是
 *    每分鐘 3,000 次、100 萬 token，但有人回報實際碰到的是「每區每分鐘 200 次」——所以一輪壓在 100 次，
 *    就算是 200 次那一種也還留一半給客人和同時在加入的知識。
 *  · 時限：排程那支（/api/cron/run-tasks）跟其他二十幾項一起跑、閘道 30 秒——過了 15 秒就不再開新的
 *    （已經開始的做完），沒輪到的下一輪（10 分鐘後）再撿。一條約 0.3 秒，100 條約 6～8 秒就做完。
 *  ⇒ 281 條約 3 輪＝30 分鐘內補完。
 */
export const RETRY_BATCH = 100
export const RETRY_CONCURRENCY = 5
export const RETRY_TIME_BUDGET_MS = 15_000
/**
 * 這一輪開頭連續失敗這麼多條、一條都沒成功 → 多半是 AI 服務本身在出事（不是那幾條的問題），這輪先停。
 * 不停的話一輪 100 條每條都 +1 次，服務停擺 50 分鐘就把全部的 5 次機會燒光、整批變成「要人按」。
 */
export const RETRY_CIRCUIT_BREAK_AFTER = 10

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
  /**
   * 建成「等你看過」的卡（`C-250`③：開帳讀網站整理出來的）。照樣算向量（試答讀得到），
   * 但狀態停在 `draft`——⛔ 要等店家在知識庫點頭才會變 `indexed`、才對客人講話。
   */
  draft?: boolean
}

/**
 * 建立一張知識卡並嘗試索引。回傳最終狀態。
 * 流程：寫 pending → embed → 寫 indexed/failed。失敗不會 throw，會回 failed。
 * （`draft` 的卡：寫 draft → embed → 仍是 draft；embed 失敗也仍是 draft，採用時再補算）
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
    // ⛔ draft 不可以先寫 pending：pending 超過 5 分鐘會被排程撿去重算、寫成 indexed＝沒看過就上線
    status: params.draft ? 'draft' : 'pending',
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
  // ⛔ 等你看過的卡同理（`C-250`③）：在審卡時改了字＝還是沒點頭，⛔ 不可以落 pending 被排程推成 indexed
  const wasDraft = existing.status === 'draft'
  await ref.update({
    ...baseUpdate,
    embedding: null,
    tokens: estimateTokens(params.content),
    status: wasDisabled ? 'disabled' : wasDraft ? 'draft' : 'pending',
    lastIndexedAt: null,
    failureReason: FieldValue.delete(),
    // 內容換了＝新的一條，自動重試的 5 次從頭算（`D-129`）：試完 5 次沒學會的，畫面建議他「改一下內容再存」——
    // 不歸零的話，改完剛好碰到 AI 服務忙、失敗一次就又直接變成「要人按」，排程也不會再撿它
    retryCount: FieldValue.delete(),
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
/**
 * ⚠️ key 仍是 sourceId（`invalidateSourceProductCache(sourceId)` 靠它清），
 *    所以來源屬於哪一家要跟著存進去、每次讀都比對——不能只在寫快取前比一次。
 */
const sourceProductCache = new Map<string, { expiresAt: number; productName: string; workspaceId: string }>()

export function invalidateSourceProductCache(sourceId?: string) {
  if (sourceId) sourceProductCache.delete(sourceId)
  else sourceProductCache.clear()
}

/**
 * G-98：卡上的 sourceId 指到別家的來源 → 當作沒有產品名。
 * 不比對的話，建索引時會把別家來源的產品名抄進這一家的卡（還前置進 embedding）。
 * 卡片自己沒有 workspaceId（理論上不會有）也一樣不給。
 */
export async function resolveSourceProductName(
  db: Firestore,
  sourceId: string | null,
  workspaceId: string | null | undefined,
): Promise<string> {
  if (!sourceId || !workspaceId) return ''
  const cached = sourceProductCache.get(sourceId)
  if (cached && cached.expiresAt > Date.now()) return cached.workspaceId === workspaceId ? cached.productName : ''
  let productName = ''
  let owner = ''
  try {
    const data = (await db.collection('knowledgeSources').doc(sourceId).get()).data() as any
    productName = String(data?.productName ?? '').trim()
    owner = String(data?.workspaceId ?? '')
  }
  catch { /* 讀不到來源就當沒有產品名，不影響索引 */ }
  sourceProductCache.set(sourceId, { expiresAt: Date.now() + SOURCE_PRODUCT_TTL_MS, productName, workspaceId: owner })
  if (owner !== workspaceId) {
    if (owner) console.warn(`[knowledge] 卡片的來源 ${sourceId} 不屬於 ${workspaceId}，不繼承它的產品名`)
    return ''
  }
  return productName
}

/**
 * 逐卡認領產品：來源層 productName 只在「一來源=一產品」時夠用，但同一產品的卡常散在
 * 「公告 / 商品資訊 / 總覽」等通用來源（productName 空），於是同一台卻併不起來、又反問。
 * 這裡讓「卡片標題自己就寫了品名」的卡直接認領該產品（優先於來源繼承），沒寫的才跟來源走。
 * productNames 是該 workspace 的正規產品名清單（backfill / 建索引時維護）。
 */
export const PRODUCT_NAMES_COLLECTION = 'knowledgeProductIndex'

// ── 這一家「現在真的有資料在用」的商品名＋型錄來源（`C-325`）────────────
/**
 * 一次掃這一家的資料清單，同時給兩樣東西（答題熱路徑、快取 60 秒）：
 *   · catalogIds：型錄／列表來源（getCatalogSourceIds 用，以前自己掃一次，現在共用這一次）
 *   · productNames：**現在有資料在用的**商品名（同一個寫法只留一個）
 *
 * 為什麼商品名改從資料算、不再讀 knowledgeProductIndex 的 names：那份清單只增不減，
 * 改名、刪掉、搬家之後舊名字照樣留著，答題端的產品鎖拿它判斷「客人在問哪一台」——
 * MYFEEL 清單留著官網首頁被認成的「MYFEEL全品項總覽」，對話裡一出現店名 MYFEEL 就鎖到這台不存在的商品、
 * 所有商品的資料都被擋掉（近 60 天 23 次轉真人，`C-325`）。同一台的其他叫法改由別名負責（ai-product-alias）。
 */
export interface WorkspaceSourceScan {
  catalogIds: Set<string>
  productNames: string[]
}
/**
 * 上限：答題熱路徑不做無上限讀取（以前型錄那一支是 200）。
 * `D-127` /code-review 第 11 條：以前 300、沒排序也沒講——整站加入幾百頁的帳號，第 301 份以後的商品名默默不在清單上，
 * 客人點名那一台時產品鎖鎖不到、型錄也被當成同主題併掉。放到 1000（只讀四格、60 秒快取，讀取費只跟真的有幾份成正比），
 * 碰到上限一定留 log
 */
const SOURCE_SCAN_LIMIT = 1000
const wsSourceScanCache = new Map<string, { expiresAt: number; scan: WorkspaceSourceScan }>()

/** 資料的商品名、型錄設定、刪除有變動時清掉（新增、改名、搬組、刪除都會走到） */
export function invalidateWorkspaceProductNames(workspaceId?: string) {
  if (workspaceId) wsSourceScanCache.delete(workspaceId)
  else wsSourceScanCache.clear()
}

export async function getWorkspaceSourceScan(db: Firestore, workspaceId: string): Promise<WorkspaceSourceScan> {
  const cached = wsSourceScanCache.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.scan
  const catalogIds = new Set<string>()
  const byKey = new Map<string, string>()
  try {
    // 只用 workspaceId 過濾（單欄位、免複合索引），其餘在程式端篩
    const snap = await db.collection('knowledgeSources')
      .where('workspaceId', '==', workspaceId)
      .select('generateOverview', 'productName', 'isDeleted', 'deletedAt')
      .limit(SOURCE_SCAN_LIMIT)
      .get()
    if (snap.size >= SOURCE_SCAN_LIMIT) {
      console.warn(`[ai-knowledge-chunks] ${workspaceId} 資料超過 ${SOURCE_SCAN_LIMIT} 份，商品名／型錄清單只掃了前 ${SOURCE_SCAN_LIMIT} 份（產品鎖可能認不到後面的商品）`)
    }
    for (const d of snap.docs) {
      const x = d.data() as { generateOverview?: boolean; productName?: string; isDeleted?: boolean; deletedAt?: unknown }
      if (x.isDeleted === true || x.deletedAt != null) continue
      if (x.generateOverview === true) catalogIds.add(d.id)
      const name = String(x.productName ?? '').trim()
      const key = normalizeProductName(name)
      if (key && !byKey.has(key)) byKey.set(key, name)
    }
  }
  catch (e) {
    // 查詢失敗不擋答題：沒有商品名＝產品鎖不鎖（維持舊行為的安全那一邊），型錄集合空＝全部照常去重
    console.warn('[ai-knowledge-chunks] workspace source scan failed:', (e as Error)?.message)
  }
  const scan = { catalogIds, productNames: [...byKey.values()] }
  wsSourceScanCache.set(workspaceId, { expiresAt: Date.now() + SOURCE_PRODUCT_TTL_MS, scan })
  return scan
}

/** 這一家現在有資料在用的商品名（見 getWorkspaceSourceScan）。名字沿用舊的，呼叫端不用改 */
export async function getWorkspaceProductNames(db: Firestore, workspaceId: string): Promise<string[]> {
  return (await getWorkspaceSourceScan(db, workspaceId)).productNames
}

/**
 * 把商品名記進 knowledgeProductIndex 的 names。
 * ⚠️ `C-325` 起答題、建索引都不讀這份了（改讀 getWorkspaceProductNames＝資料上真的在用的），
 * 這裡只剩「清掉快取讓新名字馬上生效」的作用；names 留著給搬家腳本和舊資料對照用。
 * 失敗不擋主流程。
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
  /**
   * ⛔ 同一種守門：等你看過（`draft`，`C-250`③）的卡算完向量**仍是 draft**。
   *    點頭只有一條路（`drafts/[chunkId]/adopt`，不經過這裡改狀態），否則建卡、改字、重建索引
   *    任何一條都會把「沒看過的卡」無聲寫成 indexed、直接對客人講話。
   */
  const wasDraft = cd?.status === 'draft'
  const keptStatus: KnowledgeChunkStatus | null = wasDisabled ? 'disabled' : wasDraft ? 'draft' : null
  // 解析並前置產品名：卡標題自己有品名 → 逐卡認領（優先）；否則退回來源層 productName。沒有就維持原樣。
  let productName = ''
  try {
    if (cd) {
      const sourceProduct = await resolveSourceProductName(db, cd?.sourceId ?? null, cd?.workspaceId)
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
      // 停用卡：向量照樣更新（重新啟用時免重算、不會拿到舊向量），但狀態維持 disabled（draft 同理）
      status: (keptStatus ?? 'indexed') satisfies KnowledgeChunkStatus,
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
    return { id: chunkId, status: keptStatus ?? 'indexed', embeddingTokens }
  }
  catch (err: any) {
    const reason = String(err?.statusMessage || err?.message || 'embed failed').slice(0, 300)
    // 429＝維運額度守門擋下（gemini.ts 出口；Gemini 自己的 429 會被包成 502），不是這張卡的錯：
    // 不耗 retryCount，下月額度恢復後自動重試得回來；耗掉的話 5 輪後永久 failed、額度回來也不自癒。
    const isBudgetBlock = Number(err?.statusCode) === 429
    await ref.update({
      // 停用卡 embed 失敗也不落 failed：落了就會進 retry 佇列，重試成功又寫回 indexed＝復活。
      // 向量可能因此過舊/為空——安全網在 settings.post.ts：啟用時 embedding 為空會擋下並指去「重新索引」。
      // draft 同理（落 failed 會被排程重試成 indexed）；它的安全網在採用那一步：沒向量就當場補算。
      status: (keptStatus ?? 'failed') satisfies KnowledgeChunkStatus,
      failureReason: reason,
      ...(keptStatus || isBudgetBlock ? {} : { retryCount: FieldValue.increment(1) }),
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {})
    return { id: chunkId, status: keptStatus ?? 'failed', failureReason: reason, embeddingTokens: 0 }
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
  /** 這張是「等你看過」的卡（只有試答模式會撈到，`C-250`③） */
  draft?: boolean
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
  /**
   * ⛔ 預設、而且對客人**只能**是 `indexed`。`draft` 只給試答模式（`searchSimilarChunksWithDrafts`）。
   * ⚠️ 同一支向量索引（workspaceId, status, embedding）就查得到，不必另開索引。
   */
  status: 'indexed' | 'draft' = 'indexed',
): Promise<SimilarChunk[]> {
  const baseRef = db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('status', '==', status)

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
        ...(status === 'draft' ? { draft: true } : {}),
      }
    })
}

/**
 * 試答模式（`C-250`③）：可用的卡＋等你看過的卡一起找，照相似度合併取前 K。
 * ⭐ 開帳讀完網站、卡還沒點頭的人問價格，第一個「哇」不該是一句拒答——
 *    試答照實用那張卡答，畫面標明「這句用的是還沒看過的卡」、帶他去點頭。
 * ⛔ **只有試答模式可以呼叫**（`answerWithAi` 以 `includeDrafts && isTest` 雙重把關）：
 *    對客人講話的那條路用到沒看過的卡＝紅線。
 */
export async function searchSimilarChunksWithDrafts(
  db: Firestore,
  workspaceId: string,
  queryEmbedding: number[],
  topK = 5,
): Promise<SimilarChunk[]> {
  const [live, drafts] = await Promise.all([
    searchSimilarChunks(db, workspaceId, queryEmbedding, topK, 'indexed'),
    // 草稿查不到（例如沒有草稿、或索引問題）不可以拖垮正常的試答——退回只用可用的卡
    searchSimilarChunks(db, workspaceId, queryEmbedding, topK, 'draft').catch((e) => {
      console.warn('[ai-knowledge-chunks] 試答撈等你看過的卡失敗，只用可用的卡：', (e as Error)?.message)
      return [] as SimilarChunk[]
    }),
  ])
  return [...live, ...drafts].sort((a, b) => b.similarity - a.similarity).slice(0, topK)
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
 * 型號命中的卡最多看幾張再挑（`C-307`①）。一份說明書切成幾十條、每條都標了同一個型號，
 * 要在裡面挑「跟這個問題最像的」就得先全部拿來比；設上限是讓一個很常見的型號不會一題讀上百張。
 * 實測 MYFEEL「HD7000」說明書一份就幾十條。每張多一次讀取（一題多幾十次，費用可忽略）。
 */
export const TAG_RANK_MAX_CANDIDATES = 60

/** 兩個向量的 cosine 相似度；任一邊長度不同或是零向量時回 -1（排到最後，不會被挑中） */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a?.length || a.length !== b?.length) return -1
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i])
    const y = Number(b[i])
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na && nb ? dot / Math.sqrt(na * nb) : -1
}

/** 卡片上存的向量（Firestore VectorValue 或舊資料的陣列）；沒有就回 null */
function storedEmbedding(data: any): number[] | null {
  const e = data?.embedding
  if (!e) return null
  if (typeof e.toArray === 'function') return e.toArray()
  return Array.isArray(e) ? e : null
}

/**
 * 用「識別碼精確比對」找卡。query 沒有任何英數 run 時零成本直接回空陣列
 * （純中文提問完全不會多花 Firestore 讀取）。
 *
 * 帶 queryVector（客人這句的向量）時，標了這個型號的卡**照跟問題的相似度**挑前 maxHits 張（`C-307`①）。
 * ⛔ 以前是照存放順序取前 3 張：MYFEEL「HD7000 煮飯底部黏鍋」撈到的是說明書裡排最前面的
 *    「限用物質」那幾條，黏鍋、焦掉那兩條（跟問題最像）反而沒進來——客人講得越清楚越答不出來。
 * 給的分數仍是高信心（型號對上了），只是照相似度遞減一點點，排序才看得出哪張最相關。
 * 沒帶 queryVector＝舊行為（照存放順序），留給不需要排序的呼叫端。
 */
export async function searchChunksByIdentifierTag(
  db: Firestore,
  workspaceId: string,
  query: string,
  maxHits = 3,
  queryVector?: number[],
): Promise<SimilarChunk[]> {
  const queryRuns = new Set(extractIdentifierRuns(query))
  if (!queryRuns.size) return []

  const index = await loadTagIndex(db, workspaceId)
  const rankByQuery = !!queryVector?.length
  const matchedIds = index
    .filter(e => e.runs.some(r => queryRuns.has(r)))
    .slice(0, rankByQuery ? TAG_RANK_MAX_CANDIDATES : maxHits)
    .map(e => e.id)
  if (!matchedIds.length) return []

  const refs = matchedIds.map(id => db.collection(KNOWLEDGE_CHUNKS_COLLECTION).doc(id))
  const snaps = await db.getAll(...refs)
  const nowMs = Date.now()
  const rows = snaps
    .filter(s => s.exists && s.data()?.status === 'indexed' && chunkStillActive(s.data(), nowMs))
    .map((s) => {
      const data = s.data() as any
      const emb = rankByQuery ? storedEmbedding(data) : null
      const chunk: SimilarChunk = {
        id: s.id,
        title: String(data?.title ?? ''),
        content: String(data?.content ?? ''),
        tags: Array.isArray(data?.tags) ? data.tags : [],
        similarity: TAG_MATCH_SIMILARITY,
        sourceId: data?.sourceId ?? null,
        isOverview: data?.isOverview === true,
        productName: String(data?.productName ?? '').trim() || undefined,
      }
      return { chunk, relevance: emb ? cosineSimilarity(queryVector!, emb) : -1 }
    })
  if (!rankByQuery) return rows.map(r => r.chunk)
  return rows
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxHits)
    .map((r, i) => ({ ...r.chunk, similarity: TAG_MATCH_SIMILARITY - 0.01 * i }))
}

/** ⚠️ 用 type 不用 interface：排程任務的 result 要能當 Record<string, unknown> 回（interface 不行） */
export type RetryStuckChunksResult = {
  scanned: number
  retried: number
  indexed: number
  failed: number
  skippedPermanent: number
  /** 超過本月 AI 整理用量上限的帳號，這輪跳過（不打、不耗次數，下月自動恢復） */
  skippedBudget: number
  /** 這一輪剛好用完 5 次、還是沒學會的（從這一刻起畫面才給「再試一次」） */
  exhausted: number
  /** 撿到了但這輪沒輪到（時間到、或 AI 服務看起來在出事先停）——下一輪再撿 */
  deferred: number
  /** 開頭連續失敗、一條都沒成功 → 這輪先停（RETRY_CIRCUIT_BREAK_AFTER） */
  circuitBroken: boolean
}

/**
 * 撿出 pending 卡住或 failed 的卡片重試。供排程任務呼叫（正式站走 /api/cron/run-tasks，每 10 分鐘一輪）。
 * 份量、併發、時限、熔斷的數字與理由見 RETRY_BATCH 上面那段（`D-129`）。
 * 有學會的、或這一輪剛好試完 5 次的，每個帳號記一筆操作紀錄（系統排程）——不然操作紀錄只看得到
 * 當初「失敗 N 條」那一筆，看的人以為還壞著（`C-335` 10-17 老闆就是這樣問的）。
 */
export async function retryStuckChunks(
  db: Firestore,
  opts: {
    maxBatch?: number
    pendingStuckMs?: number
    concurrency?: number
    timeBudgetMs?: number
    circuitBreakAfter?: number
    /** 測試用：現在幾點（毫秒） */
    now?: () => number
  } = {},
): Promise<RetryStuckChunksResult> {
  const maxBatch = opts.maxBatch ?? RETRY_BATCH
  const stuckMs = opts.pendingStuckMs ?? PENDING_STUCK_MS
  const concurrency = Math.max(1, opts.concurrency ?? RETRY_CONCURRENCY)
  const timeBudgetMs = opts.timeBudgetMs ?? RETRY_TIME_BUDGET_MS
  const breakAfter = opts.circuitBreakAfter ?? RETRY_CIRCUIT_BREAK_AFTER
  const now = opts.now ?? Date.now
  const startedAt = now()
  const cutoff = new Date(startedAt - stuckMs)
  // ⛔ 不讀向量：學過又失敗的卡身上還帶著舊的 768 維向量，一輪 200 條整包拉回來是白花的流量
  const FIELDS = ['workspaceId', 'title', 'content', 'questions', 'retryCount'] as const

  // 撿 failed。必須在查詢層就排除 retryCount 達上限的卡：只靠撈出後 skip 的話，
  // 全平台累積 ≥maxBatch 張永久失敗卡（一份爛 PDF 就夠）後，每次撈到的都是同一批
  // skippedPermanent，其他租戶的暫時性失敗卡永遠排不進 batch（餓死）。
  // 註：failed 卡必有 retryCount（runIndexOnChunk 失敗路徑 increment 產生），
  // 不會因 Firestore 不等式排除缺欄位文件而漏撈。需要 (status, retryCount) 複合索引。
  const failedSnap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('status', '==', 'failed')
    .where('retryCount', '<', MAX_AUTO_RETRIES)
    .select(...FIELDS)
    .limit(maxBatch)
    .get()

  // 撿 pending 太久
  const pendingSnap = await db.collection(KNOWLEDGE_CHUNKS_COLLECTION)
    .where('status', '==', 'pending')
    .where('updatedAt', '<', cutoff)
    .select(...FIELDS)
    .limit(maxBatch)
    .get()

  const scanned = failedSnap.docs.length + pendingSnap.docs.length
  const seen = new Set<string>()
  const queue: Array<{ id: string; ref: any; data: any }> = []
  for (const doc of [...failedSnap.docs, ...pendingSnap.docs]) {
    if (seen.has(doc.id)) continue
    seen.add(doc.id)
    queue.push({ id: doc.id, ref: doc.ref, data: doc.data() })
  }

  let indexed = 0
  let failed = 0
  let skippedPermanent = 0
  let skippedBudget = 0
  let exhausted = 0
  let attempts = 0
  let attemptFailures = 0
  let circuitBroken = false
  const tokensByWorkspace = new Map<string, number>()
  const perWorkspace = new Map<string, { indexed: number; failed: number; exhausted: number }>()
  const bump = (ws: string, k: 'indexed' | 'failed' | 'exhausted') => {
    if (!ws) return
    const s = perWorkspace.get(ws) ?? { indexed: 0, failed: 0, exhausted: 0 }
    s[k]++
    perWorkspace.set(ws, s)
  }

  // 超過本月 AI 整理用量上限的帳號這輪整個跳過：打了也是 429（不耗次數），白佔名額還會把熔斷誤觸發
  const budgetBlocked = new Map<string, Promise<boolean>>()
  const isBudgetBlocked = (ws: string): Promise<boolean> => {
    if (!ws) return Promise.resolve(false)
    let p = budgetBlocked.get(ws)
    if (!p) {
      p = getMaintenanceBudgetStatus(ws, db).then(s => s.blocked).catch(() => false) // 查不到不擋：打下去還有 runWithLlmBudget 守
      budgetBlocked.set(ws, p)
    }
    return p
  }

  let cursor = 0
  async function worker() {
    while (cursor < queue.length) {
      // 時間到、或 AI 服務看起來在出事 → 不再開新的（已經開始的那幾條各自做完）
      if (circuitBroken || now() - startedAt >= timeBudgetMs) return
      const item = queue[cursor++]!
      const data = item.data
      const prevCount = Number(data?.retryCount ?? 0) || 0

      // 連續失敗超過上限 → 非暫時性錯誤（內容問題等），停止自動重試。
      // 卡片維持 failed 狀態，使用者手動 reindex 仍可重試（成功會歸零 retryCount）。
      if (prevCount >= MAX_AUTO_RETRIES) {
        skippedPermanent++
        continue
      }

      const ws = typeof data?.workspaceId === 'string' ? data.workspaceId : ''
      const content = String(data?.content ?? '')
      if (!content) {
        // 空內容推不動：當場標 failed＋滿額 retryCount 讓它離開佇列。原本只 failed++ 不動文件，
        // updatedAt 永遠不變 → 這張卡每輪都排在「最舊」最前面，把別租戶真正卡住的卡
        // 擠出 limit 名額（隊頭阻塞），每天還白數 144 次。
        await item.ref.update({
          status: 'failed' satisfies KnowledgeChunkStatus,
          failureReason: '內容為空，無法建立索引',
          retryCount: MAX_AUTO_RETRIES,
          updatedAt: FieldValue.serverTimestamp(),
        }).catch(() => {})
        failed++
        exhausted++
        bump(ws, 'failed')
        bump(ws, 'exhausted')
        continue
      }
      if (await isBudgetBlocked(ws)) {
        skippedBudget++
        continue
      }
      // 份量上限算「真的打出去的次數」：跳過的不佔名額
      if (attempts >= maxBatch) return
      attempts++
      // 不帶 workspaceId:批次迴圈每卡一寫會打爆單一月用量文件,改累計、迴圈後每 workspace 一寫。
      // 額度境域（C-45）另外圈:用量途中剛好超過的，runIndexOnChunk 收到 429 不耗 retryCount，下月自動恢復
      const result = await runWithLlmBudget(ws, () => runIndexOnChunk(db, item.id, buildEmbeddingText(
        String(data?.title ?? ''),
        content,
        Array.isArray(data?.questions) ? data.questions.map(String) : [],
      )))
      if (result.status === 'indexed') {
        indexed++
        bump(ws, 'indexed')
        if (ws) tokensByWorkspace.set(ws, (tokensByWorkspace.get(ws) ?? 0) + result.embeddingTokens)
      }
      else {
        failed++
        bump(ws, 'failed')
        // 這一次也沒成＝又用掉一次；剛好用完的，從這一刻起畫面才給「再試一次」
        if (result.status === 'failed' && prevCount + 1 >= MAX_AUTO_RETRIES) {
          exhausted++
          bump(ws, 'exhausted')
        }
        // 只數真的打出去又失敗的（空內容那種不是服務的問題）
        attemptFailures++
        if (indexed === 0 && attemptFailures >= breakAfter) circuitBroken = true
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  if (circuitBroken) {
    console.warn(`[ai:retry-stuck-chunks] 開頭連續 ${attemptFailures} 條都沒學會、一條都沒成功：AI 服務可能在出事，這輪先停（剩下的不耗次數，下一輪再試）`)
  }

  // 每個 workspace 記一次帳(排程跨租戶,不能混在同一份文件)
  for (const [ws, tokens] of tokensByWorkspace) {
    if (tokens > 0) await recordAiUsage(ws, { buildEmbeddingTokens: tokens }, db)
  }

  // 操作紀錄（系統排程）：有學會的、或剛好試完 5 次的才記——只是又失敗一次（還會再試）不記，不然服務出事時每 10 分鐘洗一筆
  for (const [ws, s] of perWorkspace) {
    if (!s.indexed && !s.exhausted) continue
    const stillRetrying = s.failed - s.exhausted
    await writeAuditLog({
      workspaceId: ws,
      uid: '',
      actor: 'system',
      action: 'knowledge.autoRetry',
      after: { chunkIdsCount: s.indexed, failedItemsCount: s.failed },
      note: `之前沒學會的知識，系統自己再試：學會 ${s.indexed} 條`
        + (stillRetrying > 0 ? `、${stillRetrying} 條還沒學會（會再試）` : '')
        + (s.exhausted > 0 ? `；${s.exhausted} 條試了 ${KNOWLEDGE_MAX_AUTO_RETRIES} 次都沒學會，要人看一下（知識庫「要處理的事」）` : ''),
    }, db)
  }

  const processed = indexed + failed + skippedPermanent + skippedBudget
  return {
    scanned,
    retried: indexed + failed,
    indexed,
    failed,
    skippedPermanent,
    skippedBudget,
    exhausted,
    deferred: Math.max(0, queue.length - processed),
    circuitBroken,
  }
}
