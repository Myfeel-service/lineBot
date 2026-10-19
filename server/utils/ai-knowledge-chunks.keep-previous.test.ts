/**
 * 本來可用的知識，重學時碰上 AI 忙：保留原本學好的那份照樣讓 AI 用（`C-351`，2026-10-19 老闆「照建議」）。
 *
 * 以前：本來學好（indexed＋有向量）的知識，重學（改組名、換分組、搬家、超管全部重學、排程補學、系統補問法）那一下
 * 呼叫 AI 失敗 → 直接寫成 failed＝回客人的檢索（只撈 indexed）找不到它，要等排程補好（10-16 搬家 261 條下架約 7 分鐘）。
 *
 * 要釘住的事：
 *  ① 重學沒成：還是 indexed、向量是原本那份、記「還要重學」（relearnState='retrying'）＋次數；卡上的商品名換成新的；
 *  ② 排程撿得到這個記號、學好了換成新的（記號、次數、原因都拿掉）；
 *  ③ 試滿 5 次：還是 indexed＋原本那份；記號變 exhausted、排程不再撿；畫面給「再試一次」；體檢／紅燈（只看 failed）不亮；
 *  ④ 內容改過（店家改標題／內容／問法）：照舊清掉向量、標 failed（舊向量配新內容會撈錯）；
 *  ⑤ 第一次學（從來沒學好過）照舊標 failed；
 *  ⑥ 系統補問法（內容沒變）＝保留原本那份；
 *  ⑦ 換分組（syncSourceProductWithGroup）、超管全部重學（reindex-all）碰上 AI 忙：整份照樣讓 AI 用，數字不算成「學會」也不算成「沒學會」；
 *  ⑧ 檢索：保留的這種回客人時照樣撈得到（向量路＋型號路）。
 * 跑在記憶體裡的假 Firestore 上，embedDocument 是假的：正式庫零讀零寫、不連網。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  /** FieldValue.vector 的假物件：toArray 跟真的 VectorValue 一樣（型號路排序會讀它） */
  class Vec {
    v: number[]
    constructor(v: number[]) { this.v = v }
    toArray() { return this.v }
  }
  return {
    Vec,
    embedDocument: vi.fn(),
    getMaintenanceBudgetStatus: vi.fn(),
    writeAuditLog: vi.fn(async () => {}),
    recordAiUsage: vi.fn(async () => {}),
    isSuperAdmin: true,
    body: {} as Record<string, unknown>,
  }
})

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __op: 'ts' }),
    delete: () => ({ __op: 'del' }),
    vector: (v: number[]) => new h.Vec(v),
    increment: (n: number) => ({ __op: 'inc', n }),
    arrayUnion: (...v: unknown[]) => ({ __op: 'arrayUnion', v }),
  },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
}))
vi.mock('./gemini', () => ({
  embedDocument: h.embedDocument,
  estimateTokens: (t: string) => String(t ?? '').length,
  runWithLlmBudget: (_ws: string, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: h.recordAiUsage, getMaintenanceBudgetStatus: h.getMaintenanceBudgetStatus }))
vi.mock('./audit-log', () => ({ writeAuditLog: h.writeAuditLog }))
vi.mock('./ai-product-alias', () => ({
  getProductAliases: async () => ({ aliases: {} }),
  canonicalProductName: (s: string) => s,
  normalizeProductName: (s: string) => String(s ?? '').toLowerCase().replace(/\s+/g, ''),
  confirmAlias: async () => true,
  invalidateProductAliases: () => {},
  promoteCanonicalName: async () => '',
}))
vi.mock('./ai-knowledge-folders', () => ({ KNOWLEDGE_FOLDERS_COLLECTION: 'knowledgeFolders' }))
vi.mock('./ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  getSource: async (_db: unknown, id: string, ws: string) => {
    const d = STORE.knowledgeSources?.[id]
    return d && d.workspaceId === ws ? { id, data: { ...d } } : null
  },
  // 真的那支會存名字＋清快取；這裡只存名字（快取每個測試開頭清）
  updateSourceSettings: async (_db: unknown, ws: string, id: string, input: { productName?: string }) => {
    const d = STORE.knowledgeSources?.[id]
    if (!d || d.workspaceId !== ws) return null
    if (input.productName) d.productName = input.productName
    else delete d.productName
    return { id, productName: d.productName ?? '', folderId: d.folderId ?? null }
  },
}))
// 超管「全部重新學習」那支端點要的
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: async () => ({ workspaceId: 'ws1', uid: 'admin-1', isSuperAdmin: h.isSuperAdmin }),
}))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => h.body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

// ── 假 Firestore（多個集合、where ==／<、select、limit、findNearest、getAll、batch） ─────────────
type Row = Record<string, any>
let STORE: Record<string, Record<string, Row>> = {}
const QUERIES: Array<{ col: string; filters: Array<[string, string, unknown]> }> = []

const toMs = (v: any) => (v instanceof Date ? v.getTime() : typeof v?.toMillis === 'function' ? v.toMillis() : Number(v))
function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && v.__op === 'del') delete row[k]
    else if (v && typeof v === 'object' && v.__op === 'inc') row[k] = Number(row[k] ?? 0) + v.n
    else if (v && typeof v === 'object' && v.__op === 'arrayUnion') row[k] = [...new Set([...(row[k] ?? []), ...v.v])]
    else row[k] = v
  }
}
function ref(col: string, id: string): any {
  return {
    col,
    id,
    get: async () => ({ id, exists: !!STORE[col]?.[id], data: () => (STORE[col]?.[id] ? { ...STORE[col]![id] } : undefined) }),
    update: async (data: Row) => {
      const row = STORE[col]?.[id]
      if (!row) throw new Error(`NOT_FOUND ${col}/${id}`)
      apply(row, data)
    },
    set: async (data: Row, opts?: { merge?: boolean }) => {
      STORE[col] ??= {}
      if (opts?.merge && STORE[col]![id]) apply(STORE[col]![id]!, data)
      else { STORE[col]![id] = {}; apply(STORE[col]![id]!, data) }
    },
    delete: async () => { delete STORE[col]?.[id] },
  }
}
function matches(row: Row, [f, op, v]: [string, string, unknown]): boolean {
  if (op === '==') return row[f] === v
  if (op === '<') return row[f] !== undefined && toMs(row[f]) < toMs(v)
  return true
}
function cosine(a: number[], b: number[]) {
  let dot = 0; let na = 0; let nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2 }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}
function query(col: string, filters: Array<[string, string, unknown]> = [], limit = Infinity, fields: string[] | null = null): any {
  const rowsNow = () => Object.keys(STORE[col] ?? {}).filter(id => filters.every(f => matches(STORE[col]![id]!, f)))
  const snapOf = (ids: string[], extra: (id: string) => Row = () => ({})) => {
    const docs = ids.slice(0, limit).map(id => ({
      id,
      ref: ref(col, id),
      data: () => {
        const row = STORE[col]![id]!
        const base = fields ? Object.fromEntries(fields.filter(f => f in row).map(f => [f, row[f]])) : { ...row }
        return { ...base, ...extra(id) }
      },
    }))
    return { docs, size: docs.length, empty: !docs.length }
  }
  return {
    where: (f: string, op: string, v: unknown) => query(col, [...filters, [f, op, v]], limit, fields),
    select: (...fs: string[]) => query(col, filters, limit, fs),
    limit: (n: number) => query(col, filters, n, fields),
    orderBy: () => query(col, filters, limit, fields),
    startAfter: () => query(col, filters, limit, fields),
    doc: (id: string) => ref(col, id),
    get: async () => {
      QUERIES.push({ col, filters })
      return snapOf(rowsNow())
    },
    // Firestore Vector Search：前置篩選照 where、只看有向量的，照 cosine 距離排
    findNearest: (opts: { queryVector: { v: number[] }; limit: number }) => ({
      get: async () => {
        QUERIES.push({ col, filters })
        const dist = (id: string) => 1 - cosine(opts.queryVector.v, STORE[col]![id]!.embedding.v)
        const ids = rowsNow().filter(id => STORE[col]![id]!.embedding instanceof h.Vec).sort((a, b) => dist(a) - dist(b)).slice(0, opts.limit)
        return snapOf(ids, id => ({ _distance: dist(id) }))
      },
    }),
  }
}
const db: any = {
  collection: (col: string) => query(col),
  getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) => Promise.all(refs.map(r => r.get())),
  batch: () => {
    const ops: Array<() => void> = []
    return {
      update: (r: { col: string; id: string }, data: Row) => ops.push(() => apply(STORE[r.col]![r.id]!, data)),
      commit: async () => { for (const op of ops) op() },
    }
  },
}

const {
  createKnowledgeChunk,
  invalidateSourceProductCache,
  invalidateTagIndexCache,
  invalidateWorkspaceProductNames,
  MAX_AUTO_RETRIES,
  retryStuckChunks,
  runIndexOnChunk,
  searchChunksByIdentifierTag,
  searchSimilarChunks,
  updateKnowledgeChunk,
} = await import('./ai-knowledge-chunks')
const { relearnSourceChunks, syncSourceProductWithGroup } = await import('./ai-knowledge-product-group')
const { chunkLearnState, chunkRetryButtonShown, isAutoRetryExhausted, needsManualRetry } = await import('~~/shared/knowledge-relearn')
const reindexAll = (await import('~~/server/api/ai/knowledge/reindex-all.post')).default as unknown as (e: unknown) => Promise<Record<string, any>>

const OLD = () => new h.Vec([1, 0, 0])
const NEW = [0, 1, 0]
const busy = () => h.embedDocument.mockRejectedValue(new Error('Gemini embed: 503 UNAVAILABLE'))

/** 本來學好、AI 正在用的一條（indexed＋原本的向量） */
function seedLearned(id: string, extra: Row = {}) {
  STORE.knowledgeChunks ??= {}
  STORE.knowledgeChunks[id] = {
    workspaceId: 'ws1',
    title: `第 ${id} 條`,
    content: `內容 ${id}`,
    questions: [],
    tags: [],
    status: 'indexed',
    embedding: OLD(),
    sourceId: 's1',
    productName: '舊商品',
    isDeleted: false,
    ...extra,
  }
  return STORE.knowledgeChunks[id]!
}

beforeEach(() => {
  STORE = {
    knowledgeChunks: {},
    knowledgeSources: { s1: { workspaceId: 'ws1', name: '說明書', productName: '新商品', folderId: 'gNew' } },
    knowledgeFolders: {
      gOld: { workspaceId: 'ws1', name: '舊商品' },
      gNew: { workspaceId: 'ws1', name: '新商品' },
    },
  }
  QUERIES.length = 0
  vi.clearAllMocks()
  h.embedDocument.mockReset()
  h.embedDocument.mockResolvedValue(NEW)
  h.getMaintenanceBudgetStatus.mockReset()
  h.getMaintenanceBudgetStatus.mockResolvedValue({ used: 0, cap: 1, blocked: false })
  h.isSuperAdmin = true
  h.body = {}
  invalidateSourceProductCache()
  invalidateWorkspaceProductNames()
  invalidateTagIndexCache('ws1')
})

describe('① 重學沒成：保留原本那份照樣讓 AI 用', () => {
  it('本來學好的重學碰上 AI 忙 → 還是 indexed、向量是原本那份、記「還要重學」＋次數；卡上的商品名換成新的', async () => {
    const row = seedLearned('c1')
    const before = row.embedding
    busy()
    const r = await runIndexOnChunk(db, 'c1', '第 c1 條\n內容 c1')
    expect(r).toMatchObject({ status: 'indexed', keptPrevious: true, relearnState: 'retrying', embeddingTokens: 0 })
    const after = STORE.knowledgeChunks!.c1!
    expect(after.status).toBe('indexed') // 以前：'failed'＝AI 找不到
    expect(after.embedding).toBe(before) // ⛔ 不清、不換
    expect(after).toMatchObject({ relearnState: 'retrying', retryCount: 1, productName: '新商品' })
    expect(after.failureReason).toContain('503')
    // 畫面：還會自己再學的什麼都不講、不給按鈕；體檢／紅燈只看 failed
    expect(chunkLearnState(after)).toBe('keptRetrying')
    expect(chunkRetryButtonShown(chunkLearnState(after))).toBe(false)
    expect(isAutoRetryExhausted(after)).toBe(false)
  })

  it('額度用完（429，不是這一條的錯）：不耗次數、記號照樣 retrying（用了第 4 次的也不會因此被當成試完）', async () => {
    seedLearned('c1', { retryCount: 4, relearnState: 'retrying' })
    h.embedDocument.mockRejectedValue(Object.assign(new Error('本月 AI 整理用量用完'), { statusCode: 429 }))
    await runIndexOnChunk(db, 'c1', 'x')
    expect(STORE.knowledgeChunks!.c1).toMatchObject({ status: 'indexed', retryCount: 4, relearnState: 'retrying' })
  })
})

describe('② 排程撿得到記號、學好了換成新的', () => {
  it('relearnState=retrying 的那一條被撿去再學：學好了換新向量、記號／次數／原因都拿掉', async () => {
    seedLearned('c1', { relearnState: 'retrying', retryCount: 1, failureReason: 'Gemini embed: 503' })
    const r = await retryStuckChunks(db)
    expect(QUERIES.some(q => q.col === 'knowledgeChunks'
      && q.filters.some(([f, , v]) => f === 'relearnState' && v === 'retrying')
      && q.filters.some(([f, , v]) => f === 'status' && v === 'indexed'))).toBe(true)
    expect(r).toMatchObject({ indexed: 1, keptRelearned: 1, failed: 0 })
    const after = STORE.knowledgeChunks!.c1!
    expect(after.status).toBe('indexed')
    expect(after.embedding.v).toEqual(NEW)
    expect(after.relearnState).toBeUndefined()
    expect(after.retryCount).toBeUndefined()
    expect(after.failureReason).toBeUndefined()
    // 操作紀錄分開講：這種不是「沒學會的知識」
    const note = (h.writeAuditLog.mock.calls.at(-1) as unknown as [Record<string, any>])[0].note
    expect(note).toBe('重學沒成、AI 先用原本學好的知識，系統自己再學：學好新的 1 條')
  })

  it('排程那一輪又沒成：⛔ 還是不落 failed（照樣先用原本的），次數 +1', async () => {
    seedLearned('c1', { relearnState: 'retrying', retryCount: 1 })
    busy()
    const r = await retryStuckChunks(db, { circuitBreakAfter: 99 })
    expect(r).toMatchObject({ indexed: 0, failed: 1, keptRelearned: 0, exhausted: 0 })
    expect(STORE.knowledgeChunks!.c1).toMatchObject({ status: 'indexed', retryCount: 2, relearnState: 'retrying' })
    expect(STORE.knowledgeChunks!.c1!.embedding.v).toEqual([1, 0, 0])
  })

  it('停用的（帶記號）不撿：停用是店家的意思', async () => {
    seedLearned('c1', { status: 'disabled', relearnState: 'retrying', retryCount: 1 })
    await retryStuckChunks(db)
    expect(h.embedDocument).not.toHaveBeenCalled()
  })

  it('撿「先用原本的」那一句查不成（例如正式庫索引出狀況）：⛔ 不拖垮學失敗那幾條的重試', async () => {
    STORE.knowledgeChunks!.f1 = { workspaceId: 'ws1', title: '失敗的', content: '內容', status: 'failed', retryCount: 1, embedding: null }
    const realCollection = db.collection
    db.collection = (col: string) => {
      const q = realCollection(col)
      const where = q.where
      q.where = (f: string, op: string, v: unknown) => {
        const next = where(f, op, v)
        if (f === 'relearnState') next.where = () => ({ select: () => ({ limit: () => ({ get: async () => { throw new Error('FAILED_PRECONDITION: The query requires an index') } }) }) })
        return next
      }
      return q
    }
    try {
      const r = await retryStuckChunks(db)
      expect(r.indexed).toBe(1)
      expect(STORE.knowledgeChunks!.f1!.status).toBe('indexed')
    }
    finally {
      db.collection = realCollection
    }
  })

  it('名額先給學失敗的（客人問到找不到），先用原本的排在後面', async () => {
    seedLearned('k1', { relearnState: 'retrying', retryCount: 1 })
    STORE.knowledgeChunks!.f1 = { workspaceId: 'ws1', title: '失敗的', content: '內容', status: 'failed', retryCount: 1, embedding: null }
    await retryStuckChunks(db, { maxBatch: 1 })
    expect(STORE.knowledgeChunks!.f1!.status).toBe('indexed')
    expect(STORE.knowledgeChunks!.k1!.relearnState).toBe('retrying')
  })
})

describe('③ 試滿 5 次：照樣先用原本的，這時才給「再試一次」', () => {
  it('重學那一下失敗（1）→ 排程 4 輪都失敗 → 第 4 輪起是 exhausted、排程不再撿；一直是 indexed＋原本那份', async () => {
    seedLearned('c1')
    busy()
    await relearnSourceChunks(db, 'ws1', 's1') // 換組／改組名那一下
    expect(STORE.knowledgeChunks!.c1).toMatchObject({ retryCount: 1, relearnState: 'retrying' })
    const seen: Array<{ count: number; state: string; roundKeptExhausted: number }> = []
    for (let round = 1; round <= 5; round++) {
      const r = await retryStuckChunks(db, { circuitBreakAfter: 99 })
      const c = STORE.knowledgeChunks!.c1!
      seen.push({ count: c.retryCount, state: c.relearnState, roundKeptExhausted: r.keptExhausted })
      expect(c.status).toBe('indexed')
      expect(c.embedding.v).toEqual([1, 0, 0])
      // ⛔ 不算「客人問到找不到、要人看」的那一種（體檢、紅燈、LINE 推播都靠它）
      expect(r.exhausted).toBe(0)
    }
    expect(seen).toEqual([
      { count: 2, state: 'retrying', roundKeptExhausted: 0 },
      { count: 3, state: 'retrying', roundKeptExhausted: 0 },
      { count: 4, state: 'retrying', roundKeptExhausted: 0 },
      { count: MAX_AUTO_RETRIES, state: 'exhausted', roundKeptExhausted: 1 },
      { count: MAX_AUTO_RETRIES, state: 'exhausted', roundKeptExhausted: 0 }, // 不再撿
    ])
    expect(h.embedDocument).toHaveBeenCalledTimes(5) // 重學那一下 1 次＋排程 4 次
    const c = STORE.knowledgeChunks!.c1!
    expect(chunkLearnState(c)).toBe('keptExhausted')
    expect(chunkRetryButtonShown(chunkLearnState(c))).toBe(true)
    expect(needsManualRetry(c)).toBe(true)
    expect(isAutoRetryExhausted(c)).toBe(false)
    const note = (h.writeAuditLog.mock.calls.at(-1) as unknown as [Record<string, any>])[0].note
    expect(note).toBe(`重學沒成、AI 先用原本學好的知識，系統自己再學：學好新的 0 條；1 條試了 ${MAX_AUTO_RETRIES} 次都沒學好，AI 繼續用原本學好的`)
  })

  it('試完之後按「再試一次」學好了：換成新的、記號拿掉；又沒成：還是先用原本的、記號留 exhausted', async () => {
    seedLearned('c1', { relearnState: 'exhausted', retryCount: 5 })
    busy()
    const again = await runIndexOnChunk(db, 'c1', 'x', 'ws1')
    expect(again).toMatchObject({ status: 'indexed', keptPrevious: true, relearnState: 'exhausted' })
    expect(STORE.knowledgeChunks!.c1).toMatchObject({ status: 'indexed', retryCount: 6, relearnState: 'exhausted' })
    h.embedDocument.mockResolvedValue(NEW)
    const ok = await runIndexOnChunk(db, 'c1', 'x', 'ws1')
    expect(ok.keptPrevious).toBeUndefined()
    expect(STORE.knowledgeChunks!.c1!.relearnState).toBeUndefined()
    expect(STORE.knowledgeChunks!.c1!.embedding.v).toEqual(NEW)
  })
})

describe('④ 內容改過：照舊清掉向量、標 failed（舊向量配新內容會撈錯）', () => {
  it('店家改了內容、學失敗 → failed、向量清掉、沒有「先用原本的」記號', async () => {
    seedLearned('c1')
    busy()
    const r = await updateKnowledgeChunk(db, { chunkId: 'c1', title: '第 c1 條', content: '改過的內容', contentChanged: true, manualEdit: true })
    expect(r.status).toBe('failed')
    expect(r.keptPrevious).toBeUndefined()
    const c = STORE.knowledgeChunks!.c1!
    expect(c).toMatchObject({ status: 'failed', embedding: null, retryCount: 1 })
    expect(c.relearnState).toBeUndefined()
  })

  it('正在先用原本的那一條被改了內容、又碰上 AI 忙：記號一起拿掉（要學的已經是新的一條，照學失敗那條路從 1 次算起）', async () => {
    seedLearned('c1', { relearnState: 'exhausted', retryCount: 5 })
    busy()
    await updateKnowledgeChunk(db, { chunkId: 'c1', title: '第 c1 條', content: '改過的內容', contentChanged: true, manualEdit: true })
    const c = STORE.knowledgeChunks!.c1!
    expect(c).toMatchObject({ status: 'failed', embedding: null, retryCount: 1 })
    expect(c.relearnState).toBeUndefined()
    expect(chunkLearnState(c)).toBe('retrying')
  })

  it('店家自己手改問法（manualEdit）也算：照舊 failed——他改問法就是要換掉哪些問題會撈到這一條', async () => {
    seedLearned('c1', { questions: ['舊的問法'] })
    busy()
    const r = await updateKnowledgeChunk(db, { chunkId: 'c1', title: '第 c1 條', content: '內容 c1', questions: ['新的問法'], contentChanged: false, manualEdit: true })
    expect(r.status).toBe('failed')
    expect(STORE.knowledgeChunks!.c1!.embedding).toBeNull()
  })
})

describe('⑤ 第一次學（從來沒學好過）照舊標 failed', () => {
  it('加入一條、學失敗 → failed、沒有「先用原本的」記號', async () => {
    busy()
    const r = await createKnowledgeChunk(db, { workspaceId: 'ws1', chunkId: 'n1', title: '新的', content: '新的內容', tags: [], sourceId: 's1' })
    expect(r.status).toBe('failed')
    const c = STORE.knowledgeChunks!.n1!
    expect(c).toMatchObject({ status: 'failed', embedding: null, retryCount: 1 })
    expect(c.relearnState).toBeUndefined()
  })

  it('學失敗過、還沒學好的那一條再學又失敗 → 還是 failed（它從來沒有原本那份可以用）', async () => {
    STORE.knowledgeChunks!.f1 = { workspaceId: 'ws1', title: 't', content: 'c', status: 'failed', retryCount: 1, embedding: null, sourceId: 's1' }
    busy()
    await retryStuckChunks(db, { circuitBreakAfter: 99 })
    expect(STORE.knowledgeChunks!.f1).toMatchObject({ status: 'failed', retryCount: 2 })
    expect(STORE.knowledgeChunks!.f1!.relearnState).toBeUndefined()
  })
})

describe('⑥ 系統補問法（內容沒變）＝保留原本那份', () => {
  it('補問法那一下碰上 AI 忙：還是 indexed、向量是原本那份、新問法存著、記號留給排程', async () => {
    seedLearned('c1')
    busy()
    const r = await updateKnowledgeChunk(db, { chunkId: 'c1', title: '第 c1 條', content: '內容 c1', questions: ['客人會怎麼問'], contentChanged: false, manualEdit: false })
    expect(r).toMatchObject({ status: 'indexed', keptPrevious: true })
    const c = STORE.knowledgeChunks!.c1!
    expect(c.embedding.v).toEqual([1, 0, 0])
    expect(c).toMatchObject({ status: 'indexed', questions: ['客人會怎麼問'], relearnState: 'retrying', retryCount: 1 })
  })

  it('學成了：新向量、沒有記號（「還要重學」是先寫上去再學的，學成才拿掉）', async () => {
    seedLearned('c1')
    await updateKnowledgeChunk(db, { chunkId: 'c1', title: '第 c1 條', content: '內容 c1', questions: ['客人會怎麼問'], contentChanged: false, manualEdit: false })
    const c = STORE.knowledgeChunks!.c1!
    expect(c.embedding.v).toEqual(NEW)
    expect(c.relearnState).toBeUndefined()
  })
})

describe('⑦ 換分組、超管全部重學碰上 AI 忙', () => {
  it('換分組（當場重學這一份）：每一條照樣讓 AI 用；數字不算「學會」也不算「沒學會」；操作紀錄講先用原本的', async () => {
    STORE.knowledgeSources!.s1 = { workspaceId: 'ws1', name: '說明書', productName: '舊商品', folderId: 'gNew' } // 剛搬進「新商品」
    seedLearned('c1')
    seedLearned('c2')
    busy()
    const r = await syncSourceProductWithGroup(db, 'ws1', 's1', { uid: 'staff-1' })
    expect(r.changed).toBe(true)
    if (!r.changed) return
    expect(r.relearned).toMatchObject({ total: 2, indexed: 0, failed: 0, kept: 2 })
    for (const id of ['c1', 'c2']) {
      const c = STORE.knowledgeChunks![id]!
      expect(c.status).toBe('indexed')
      expect(c.embedding.v).toEqual([1, 0, 0])
      expect(c).toMatchObject({ relearnState: 'retrying', productName: '新商品' })
    }
    // 資料上的「還沒重新學」記號照樣拿掉：每一條自己帶記號給 retryStuckChunks，不用整份再學一次
    expect(STORE.knowledgeSources!.s1!.productRelearnPending).toBeUndefined()
    const audit = (h.writeAuditLog.mock.calls.at(-1) as unknown as [Record<string, any>])[0]
    expect(audit.note).toContain('照新的商品名學會 0 條、2 條先用原本學好的（會自己再學）')
    expect(audit.note).not.toContain('還沒學會')
  })

  it('超管「全部重新學習」：本來學好的照樣讓 AI 用、另外數；從來沒學好的照舊算失敗', async () => {
    seedLearned('c1')
    STORE.knowledgeChunks!.f1 = { workspaceId: 'ws1', title: 't', content: 'c', status: 'failed', retryCount: 1, embedding: null, sourceId: 's1' }
    busy()
    const res = await reindexAll({})
    expect(res).toMatchObject({ indexed: 0, failed: 1, kept: 1 })
    expect(STORE.knowledgeChunks!.c1).toMatchObject({ status: 'indexed', relearnState: 'retrying' })
    expect(STORE.knowledgeChunks!.f1!.status).toBe('failed')
  })
})

describe('⑧ 檢索：保留的這種回客人時照樣撈得到', () => {
  it('向量路（findNearest 只撈 indexed）：重學沒成的那一條照樣在結果裡、用原本的向量排', async () => {
    seedLearned('c1')
    seedLearned('c2', { embedding: new h.Vec([0, 0, 1]) })
    busy()
    await relearnSourceChunks(db, 'ws1', 's1')
    expect(STORE.knowledgeChunks!.c1!.relearnState).toBe('retrying')
    const hits = await searchSimilarChunks(db, 'ws1', [1, 0, 0], 5)
    expect(hits.map(x => x.id)).toEqual(['c1', 'c2'])
    expect(hits[0]!.similarity).toBeCloseTo(1)
    expect(hits[0]!.productName).toBe('新商品')
  })

  it('型號路（客人打型號）：標了型號的那一條照樣命中', async () => {
    seedLearned('c1', { tags: ['HD7000'] })
    busy()
    await runIndexOnChunk(db, 'c1', 'x')
    const hits = await searchChunksByIdentifierTag(db, 'ws1', 'HD7000 黏鍋怎麼辦', 3, [1, 0, 0])
    expect(hits.map(x => x.id)).toEqual(['c1'])
  })
})
