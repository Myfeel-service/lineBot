import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 知識卡引用的來源、資料夾要是這個帳號的（`G-98`，2026-09-29 權限盤點）。
 *
 * 🔴 建卡的 sourceId 原本不驗：卡片列表與回收桶會回傳別家來源的名稱，
 *    建索引時還會把別家來源的產品名抄進自家的卡。
 * 🔴 folderId 原本不驗：填了不存在的資料夾，那份資料會從側欄整份消失。
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
}))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  addWorkspaceProductName: vi.fn(async () => {}),
  createKnowledgeChunk: vi.fn(async (_db: unknown, o: { chunkId: string }) => ({ id: o.chunkId, status: 'indexed', embeddingTokens: 1 })),
  normalizeChunkInput: (raw: any) => ({
    title: String(raw?.title ?? ''),
    content: String(raw?.content ?? ''),
    tags: [],
    questions: undefined,
    sourceId: raw?.sourceId ? String(raw.sourceId) : null,
    isOverview: false,
  }),
  validateChunkInput: () => null,
  buildChunkSoftDeletePatch: vi.fn(),
  invalidateSourceProductCache: vi.fn(),
  invalidateTagIndexCache: vi.fn(),
}))
vi.mock('~~/server/utils/ai-knowledge-quota', () => ({
  assertKnowledgeChunkQuota: vi.fn(async () => {}),
  invalidateKnowledgeChunkCount: vi.fn(),
}))
vi.mock('~~/server/utils/ai-usage', () => ({
  assertMaintenanceBudget: vi.fn(async () => {}),
  recordAiUsage: vi.fn(async () => {}),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/paginated-collection-list', () => ({ queryCollectionPage: vi.fn() }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('getQuery', () => ({}))
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { getDb } = await import('~~/server/utils/firebase')
const { createKnowledgeChunk } = await import('~~/server/utils/ai-knowledge-chunks')
const { queryCollectionPage } = await import('~~/server/utils/paginated-collection-list')
const { default: createHandler } = await import('./create.post')
const { default: bulkCreateHandler } = await import('./bulk-create.post')
const { default: listHandler } = await import('./list.get')
const { default: recycleHandler } = await import('./recycle-bin.get')

const STORE: Record<string, Record<string, Record<string, unknown>>> = {
  knowledgeSources: {
    srcMine: { workspaceId: WS, name: '我家的說明書', type: 'file' },
    srcTheirs: { workspaceId: 'ws2', name: '別家的機密價目表', type: 'file' },
  },
  knowledgeFolders: {
    fMine: { workspaceId: WS, name: '產品說明' },
    fTheirs: { workspaceId: 'ws2', name: '別家的' },
  },
}
const sets: Array<{ col: string, id: string, data: any }> = []
const updates: Array<{ col: string, id: string, data: any }> = []
const snap = (col: string, id: string) => ({ id, exists: !!STORE[col]?.[id], data: () => STORE[col]?.[id] })
/** 查詢一律回回收桶那兩張卡（其餘查詢——bulk-create 回寫張數用的 count——不在乎內容） */
const query: any = {
  where: () => query,
  orderBy: () => query,
  select: () => query,
  limit: () => query,
  count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
  get: async () => ({
    size: 2,
    docs: [
      { id: 'c1', data: () => ({ title: '卡一', content: '', sourceId: 'srcMine' }) },
      { id: 'c2', data: () => ({ title: '卡二', content: '', sourceId: 'srcTheirs' }) },
    ],
  }),
}
const db: any = {
  collection: (col: string) => ({
    doc: (id: string) => ({
      get: async () => snap(col, id),
      set: async (data: any) => { sets.push({ col, id, data }) },
      update: async (data: any) => { updates.push({ col, id, data }) },
    }),
    where: () => query,
  }),
  getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) => Promise.all(refs.map(r => r.get())),
}

const call = (h: unknown) => (h as (e: unknown) => Promise<any>)({})

beforeEach(() => {
  vi.clearAllMocks()
  sets.length = 0
  updates.length = 0
  vi.mocked(getDb).mockReturnValue(db)
})

describe('POST /api/ai/knowledge/create', () => {
  it('掛進自己的來源 → 照建', async () => {
    body = { title: 't', content: 'c', sourceId: 'srcMine' }
    await expect(call(createHandler)).resolves.toMatchObject({ sourceId: 'srcMine' })
    expect(createKnowledgeChunk).toHaveBeenCalledTimes(1)
  })

  it('🔴 掛進別家的來源 → 404，卡片不建', async () => {
    body = { title: 't', content: 'c', sourceId: 'srcTheirs' }
    await expect(call(createHandler)).rejects.toMatchObject({ statusCode: 404 })
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
  })

  it('🔴 自動建來源時放進別家的資料夾 → 404，來源與卡片都不建', async () => {
    body = { title: 't', content: 'c', folderId: 'fTheirs' }
    await expect(call(createHandler)).rejects.toMatchObject({ statusCode: 404 })
    expect(sets).toHaveLength(0)
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
  })

  it('放進自己的資料夾 → 新來源帶著那個資料夾', async () => {
    body = { title: 't', content: 'c', folderId: 'fMine' }
    await call(createHandler)
    expect(sets.find(s => s.col === 'knowledgeSources')!.data.folderId).toBe('fMine')
  })
})

describe('POST /api/ai/knowledge/bulk-create', () => {
  it('🔴 放進別家的資料夾 → 404，來源與卡片都不建', async () => {
    body = { source: { type: 'file', name: 'x', folderId: 'fTheirs' }, chunks: [{ title: 't', content: 'c' }] }
    await expect(call(bulkCreateHandler)).rejects.toMatchObject({ statusCode: 404 })
    expect(sets).toHaveLength(0)
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
  })

  it('放進自己的資料夾 → 照建', async () => {
    body = { source: { type: 'file', name: 'x', folderId: 'fMine' }, chunks: [{ title: 't', content: 'c' }] }
    await call(bulkCreateHandler)
    expect(sets.find(s => s.col === 'knowledgeSources')!.data.folderId).toBe('fMine')
  })
})

describe('updateSourceSettings（來源設定 PUT 用的那支）：搬資料夾', () => {
  it('🔴 搬進別家的資料夾 → 404，來源不動', async () => {
    const { updateSourceSettings } = await import('~~/server/utils/ai-knowledge-sources')
    await expect(updateSourceSettings(db, WS, 'srcMine', { folderId: 'fTheirs' })).rejects.toMatchObject({ statusCode: 404 })
    expect(updates).toHaveLength(0)
  })

  it('搬進自己的資料夾、或移出資料夾（null）→ 照改', async () => {
    const { updateSourceSettings } = await import('~~/server/utils/ai-knowledge-sources')
    await updateSourceSettings(db, WS, 'srcMine', { folderId: 'fMine' })
    await updateSourceSettings(db, WS, 'srcMine', { folderId: null })
    expect(updates.map(u => u.data.folderId)).toEqual(['fMine', null])
  })
})

describe('讀的那一側：卡上指到別家來源時，名稱不讀出去', () => {
  it('🔴 卡片列表', async () => {
    vi.mocked(queryCollectionPage).mockResolvedValue({
      items: [{ id: 'c1', sourceId: 'srcMine' }, { id: 'c2', sourceId: 'srcTheirs' }],
    } as never)
    const res = await call(listHandler)
    expect(res.items[0].sourceName).toBe('我家的說明書')
    expect(res.items[1].sourceName).toBe('')
    expect(JSON.stringify(res)).not.toContain('別家的機密價目表')
  })

  it('🔴 回收桶', async () => {
    const res = await call(recycleHandler)
    expect(res.items.find((r: any) => r.id === 'c1').sourceName).toBe('我家的說明書')
    expect(res.items.find((r: any) => r.id === 'c2').sourceName).toBeNull()
    expect(JSON.stringify(res)).not.toContain('別家的機密價目表')
  })
})
