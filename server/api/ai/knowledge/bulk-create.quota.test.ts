import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 匯入前的知識量檢查算對沒有（`C-296`）。以前算錯過的地方：
 *  ① 總表也是一條、也算額度——沒算進去，剛好滿的時候會超收 1 條；
 *  ② 「更新這一份」的舊卡等一下就進回收桶——照算的話，換一份新版說明書會被自己的舊卡擋下；
 *  ③ ⛔ 騰出空間的前提是「真的會收舊卡」：source 缺或寫成 manual 時舊卡根本不會收，
 *     以前照扣——每送一次就多塞一份舊卡數量的卡（審查抓到的繞過）；
 *  ④ ⛔ 騰出多少要用額度的尺數：草稿本來就沒算額度，不能當成騰出來的空間。
 * 數張數用的是真的 countSourceQuotaChunks，跑在記憶體裡的假 Firestore 上（正式庫零讀零寫）。
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/ai-usage', () => ({
  assertMaintenanceBudget: vi.fn(async () => {}),
  recordAiUsage: vi.fn(async () => {}),
}))
vi.mock('~~/server/utils/ai-knowledge-quota', () => ({
  // 檢查之後的建檔流程不在這支測試的範圍：擋在這裡就好
  assertKnowledgeChunkQuota: vi.fn(async () => { throw Object.assign(new Error('stop-after-quota'), { statusCode: 499 }) }),
  invalidateKnowledgeChunkCount: vi.fn(),
}))
vi.mock('~~/server/utils/ai-knowledge-sources', async (importActual) => {
  const actual = await importActual<typeof import('~~/server/utils/ai-knowledge-sources')>()
  return {
    ...actual,
    recycleSourceChunks: vi.fn(async () => 0),
    invalidateCatalogSourceCache: vi.fn(),
  }
})
vi.mock('~~/server/utils/ai-knowledge-folder-guard', () => ({ resolveKnowledgeFolderId: vi.fn(async () => null) }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  addWorkspaceProductName: vi.fn(),
  buildChunkSoftDeletePatch: vi.fn(),
  invalidateSourceProductCache: vi.fn(),
  invalidateTagIndexCache: vi.fn(),
  createKnowledgeChunk: vi.fn(),
  normalizeChunkInput: (raw: any) => ({ title: String(raw?.title ?? ''), content: String(raw?.content ?? ''), tags: [], questions: [], sourceId: null, isOverview: false }),
  validateChunkInput: () => null,
}))

/** 假 Firestore：文件放在 STORE[collection][id]；where 只做等值比對、count() 數符合的 */
const STORE: Record<string, Record<string, Record<string, any>>> = {}
function query(col: string, filters: Array<[string, unknown]> = []): any {
  const match = () => Object.entries(STORE[col] ?? {}).filter(([, d]) => filters.every(([f, v]) => d[f] === v))
  return {
    where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]]),
    count: () => ({ get: async () => ({ data: () => ({ count: match().length }) }) }),
    doc: (id: string) => ({
      id,
      get: async () => ({ id, exists: !!STORE[col]?.[id], data: () => STORE[col]?.[id] }),
    }),
  }
}
const db: any = { collection: (col: string) => query(col), getAll: async () => [] }
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { assertKnowledgeChunkQuota } = await import('~~/server/utils/ai-knowledge-quota')
const { recycleSourceChunks } = await import('~~/server/utils/ai-knowledge-sources')
const { createKnowledgeChunk } = await import('~~/server/utils/ai-knowledge-chunks')
const { default: handler } = await import('./bulk-create.post')

const call = () => (handler as unknown as (e: unknown) => Promise<any>)({}).catch((e: any) => e)
const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `第 ${i + 1} 條`, content: '內容' }))
const addingAsked = () => vi.mocked(assertKnowledgeChunkQuota).mock.calls[0]![1]

/** 在某份資料底下放卡：live 張正常的、drafts 張等你看過、deleted 張在回收桶 */
function seedChunks(sourceId: string, ws: string, live: number, drafts = 0, deleted = 0) {
  STORE.knowledgeChunks ??= {}
  const put = (n: number, extra: Record<string, unknown>, tag: string) => {
    for (let i = 0; i < n; i++) {
      STORE.knowledgeChunks![`${sourceId}-${tag}-${i}`] = { workspaceId: ws, sourceId, status: 'indexed', isDeleted: false, ...extra }
    }
  }
  put(live, {}, 'live')
  put(drafts, { status: 'draft' }, 'draft')
  put(deleted, { isDeleted: true, status: 'disabled' }, 'deleted')
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
  STORE.knowledgeSources = {
    srcMine: { workspaceId: WS, type: 'file', name: '說明書.pdf', isDeleted: false },
    srcTheirs: { workspaceId: 'ws2', type: 'file', name: '說明書.pdf', isDeleted: false },
    srcSheet: { workspaceId: WS, type: 'gsheet', name: '價目表', isDeleted: false },
    srcBinned: { workspaceId: WS, type: 'manual', name: '貼上的文字', isDeleted: true, deletedAt: '__ts__' },
  }
  seedChunks('srcMine', WS, 40)
  seedChunks('srcTheirs', 'ws2', 40)
})

describe('bulk-create 的知識量檢查', () => {
  it('總表也算一條：3 條＋總表＝要 4 條的空間', async () => {
    body = { source: { type: 'file', name: '型錄.pdf' }, chunks: cards(3), overviewCard: { title: '總表', content: '我們有 A、B、C' } }
    await call()
    expect(addingAsked()).toBe(4)
  })

  it('「更新這一份」：舊的 40 條會退場，新版 42 條只多佔 2 條', async () => {
    body = { source: { type: 'file', name: '說明書.pdf' }, chunks: cards(42), replaceSourceId: 'srcMine' }
    await call()
    expect(addingAsked()).toBe(2)
  })

  it('⛔ 草稿與回收桶裡的舊卡不算騰出空間：40 條正常＋10 張草稿＋5 張回收桶，換 42 條新的要 2 條', async () => {
    seedChunks('srcMine', WS, 0, 10, 5)
    body = { source: { type: 'file', name: '說明書.pdf' }, chunks: cards(42), replaceSourceId: 'srcMine' }
    await call()
    // 以前用 countSourceChunks（含草稿）扣：42 − 50 ＝ −8，等於憑空多出 10 條空間
    expect(addingAsked()).toBe(2)
  })

  it('⛔ 拿別家的來源 id 來「更新」→ 404，額度連算都不算、舊卡一張都不動', async () => {
    body = { source: { type: 'file', name: '說明書.pdf' }, chunks: cards(3), replaceSourceId: 'srcTheirs' }
    await expect(call()).resolves.toMatchObject({ statusCode: 404 })
    expect(assertKnowledgeChunkQuota).not.toHaveBeenCalled()
    expect(recycleSourceChunks).not.toHaveBeenCalled()
  })

  it('⛔ 繞過（一）：帶自己的來源 id、source 卻沒給 → 400，不會被算成騰出 40 條、也不建卡', async () => {
    body = { chunks: cards(40), replaceSourceId: 'srcMine' }
    await expect(call()).resolves.toMatchObject({ statusCode: 400 })
    expect(assertKnowledgeChunkQuota).not.toHaveBeenCalled()
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
  })

  it('⛔ 繞過（二）：source.type 寫成 manual（不會收舊卡的種類）→ 400', async () => {
    body = { source: { type: 'manual', name: '說明書.pdf' }, chunks: cards(40), replaceSourceId: 'srcMine' }
    await expect(call()).resolves.toMatchObject({ statusCode: 400 })
    expect(assertKnowledgeChunkQuota).not.toHaveBeenCalled()
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
  })

  it('種類不同（拿檔案蓋 Google 試算表）→ 400，在算額度之前就擋', async () => {
    body = { source: { type: 'file', name: '價目表' }, chunks: cards(3), replaceSourceId: 'srcSheet' }
    await expect(call()).resolves.toMatchObject({ statusCode: 400, statusMessage: expect.stringContaining('不能用檔案覆蓋') })
    expect(assertKnowledgeChunkQuota).not.toHaveBeenCalled()
  })

  it('⛔ 在回收桶的那一份 → 404（照蓋會把它整份從回收桶救回來）', async () => {
    body = { source: { type: 'text', name: '貼上的文字' }, chunks: cards(3), replaceSourceId: 'srcBinned' }
    await expect(call()).resolves.toMatchObject({ statusCode: 404 })
    expect(recycleSourceChunks).not.toHaveBeenCalled()
  })

  it('找不到的來源 id → 404，不默默改成新建一份', async () => {
    body = { source: { type: 'file', name: '說明書.pdf' }, chunks: cards(3), replaceSourceId: 'srcGone' }
    await expect(call()).resolves.toMatchObject({ statusCode: 404 })
  })
})

describe('bulk-create 的編號檢查：壞編號要 400，⛔ 不可以變成沒有訊息的 500', () => {
  it.each([
    ['含斜線的來源 id', { replaceSourceId: 'knowledgeSources/srcMine' }],
    ['中間有空白', { replaceSourceId: 'src mine' }],
    ['Firestore 保留字', { replaceSourceId: '__srcMine__' }],
    ['太長', { replaceSourceId: 'a'.repeat(65) }],
    ['含斜線的匯入編號（會拿去組暫存檔路徑）', { importId: '../ws2/job' }],
    ['匯入編號不是字串', { importId: { $gt: '' } }],
  ])('%s → 400', async (_label, extra) => {
    body = { source: { type: 'file', name: '說明書.pdf' }, chunks: cards(3), ...extra }
    await expect(call()).resolves.toMatchObject({ statusCode: 400, statusMessage: expect.stringContaining('請重新整理頁面') })
    expect(assertKnowledgeChunkQuota).not.toHaveBeenCalled()
  })

  it('空字串＝沒帶（不是錯）', async () => {
    body = { source: { type: 'file', name: '說明書.pdf' }, chunks: cards(3), replaceSourceId: '', importId: '  ' }
    await call()
    expect(addingAsked()).toBe(3)
  })
})
