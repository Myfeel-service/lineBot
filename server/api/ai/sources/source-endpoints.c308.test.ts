import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 整份資料的刪除與設定（`C-308`③⑧、`D-125`②，2026-10-13）。
 *
 * ⑧ 刪掉一整份之後，「還剩幾條空間」最多 1 分鐘不更新——照提示刪完馬上加，還是說滿了。
 * ③ 🔴 刪的同時試算表同步正在一條條建：刪除先數名單再刪，名單數完之後才建的變成「AI 會用、
 *    後台看不到也刪不掉」的孤兒（正式站測試撞到 9 條）。刪完要再掃一輪。
 * D-125② 「在後台刪掉、不再收」的列可以一次收回來（PUT clearExcludedRows）：清名單＋清指紋
 *    （不清指紋，表格沒變的話同步直接跳過，那幾列要等表格別處改過才回來）。
 * 數張數、刪除、改設定都用真的 ai-knowledge-sources，跑在記憶體裡的假 Firestore 上。
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
  Timestamp: { fromMillis: (ms: number) => ({ __ts: ms }) },
}))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/audit-log', async importOriginal => ({
  ...(await importOriginal<typeof import('~~/server/utils/audit-log')>()),
  writeAuditLog: vi.fn(async () => {}),
}))
vi.mock('~~/server/utils/ai-knowledge-quota', () => ({ invalidateKnowledgeChunkCount: vi.fn() }))
vi.mock('~~/server/utils/knowledge-source-files', () => ({ deleteSourceFiles: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  addWorkspaceProductName: vi.fn(async () => {}),
  buildChunkSoftDeletePatch: vi.fn(),
  invalidateSourceProductCache: vi.fn(),
  invalidateTagIndexCache: vi.fn(),
}))

const STORE: Record<string, Record<string, Record<string, any>>> = {}
const hooks = { afterFirstChunkQuery: () => {} }
let chunkQueries = 0
function docRef(col: string, id: string): any {
  return {
    id,
    get: async () => ({ id, exists: !!STORE[col]?.[id], data: () => STORE[col]?.[id] }),
    update: async (p: Record<string, any>) => {
      if (!STORE[col]?.[id]) throw new Error('NOT_FOUND')
      for (const [k, v] of Object.entries(p)) {
        if (v === '__del__') delete STORE[col][id]![k]
        else STORE[col][id]![k] = v
      }
    },
    delete: async () => { delete STORE[col]?.[id] },
    collection: (sub: string) => ({ doc: (subId: string) => docRef(`${col}/${id}/${sub}`, subId) }),
  }
}
function query(col: string, filters: Array<[string, unknown]> = []): any {
  return {
    where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]]),
    get: async () => {
      const docs = Object.entries(STORE[col] ?? {})
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => ({ id, data: () => d, ref: docRef(col, id) }))
      if (col === 'knowledgeChunks' && ++chunkQueries === 1) hooks.afterFirstChunkQuery()
      return { empty: !docs.length, size: docs.length, docs }
    },
  }
}
const db: any = {
  collection: (col: string) => ({ doc: (id: string) => docRef(col, id), where: (f: string, op: string, v: unknown) => query(col).where(f, op, v) }),
  batch: () => {
    const ops: Array<() => Promise<void>> = []
    return { delete: (r: any) => ops.push(() => r.delete()), commit: async () => { for (const op of ops) await op() } }
  },
}
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('getRouterParam', () => 'sheet1')
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { invalidateKnowledgeChunkCount } = await import('~~/server/utils/ai-knowledge-quota')
const { writeAuditLog } = await import('~~/server/utils/audit-log')
const { docToSourceSummary } = await import('~~/server/utils/ai-knowledge-sources')
const { default: deleteHandler } = await import('./[sourceId].delete')
const { default: putHandler } = await import('./[sourceId].put')
const run = (h: unknown) => (h as (e: unknown) => Promise<any>)({})

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
  chunkQueries = 0
  hooks.afterFirstChunkQuery = () => {}
  STORE.knowledgeSources = {
    sheet1: { workspaceId: WS, type: 'gsheet', name: '價目表', contentHash: 'h1', gsheetExcludedTitles: ['A', 'B'], updatedAt: null },
  }
  STORE.knowledgeChunks = {
    c1: { workspaceId: WS, sourceId: 'sheet1', title: 'C' },
    c2: { workspaceId: WS, sourceId: 'sheet1', title: 'D' },
  }
})

describe('刪掉一整份（`C-308`③⑧）', () => {
  it('🔴 刪的同時同步還在建（名單數完才建的那條）→ 刪完再掃一輪，0 條孤兒；空間快取馬上作廢', async () => {
    hooks.afterFirstChunkQuery = () => { STORE.knowledgeChunks!.late = { workspaceId: WS, sourceId: 'sheet1', title: 'E' } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await run(deleteHandler)
    expect(r.chunksDeleted).toBe(3)
    expect(Object.keys(STORE.knowledgeChunks!)).toEqual([])
    expect(STORE.knowledgeSources!.sheet1).toBeUndefined()
    expect(invalidateKnowledgeChunkCount).toHaveBeenCalledWith(WS)
    expect(vi.mocked(writeAuditLog).mock.calls[0]![0].note).toBe('價目表：連同底下 3 條知識一起刪掉了（救不回來）')
    warn.mockRestore()
  })
})

describe('「在後台刪掉、不再收」的列收回來（`D-125`②）', () => {
  it('清名單＋清指紋（下一次同步整份比對、把那幾列加回來）、紀錄講幾列', async () => {
    body = { clearExcludedRows: true }
    const r = await run(putHandler)
    expect(r.gsheetExcludedTitles).toEqual([])
    expect(STORE.knowledgeSources!.sheet1!.contentHash).toBe('')
    expect(vi.mocked(writeAuditLog).mock.calls[0]![0].note).toBe('價目表：在後台刪掉的 2 列重新收回來，下一次同步會加回知識庫')
  })

  it('⛔ 不是試算表 → 400，什麼都不動', async () => {
    STORE.knowledgeSources!.sheet1!.type = 'file'
    body = { clearExcludedRows: true }
    await expect(run(putHandler)).rejects.toMatchObject({ statusCode: 400 })
    expect(STORE.knowledgeSources!.sheet1!.gsheetExcludedTitles).toEqual(['A', 'B'])
    expect(STORE.knowledgeSources!.sheet1!.contentHash).toBe('h1')
  })

  it('沒帶 clearExcludedRows → 名單跟指紋都不動', async () => {
    body = { name: '新價目表' }
    await run(putHandler)
    expect(STORE.knowledgeSources!.sheet1!.gsheetExcludedTitles).toEqual(['A', 'B'])
    expect(STORE.knowledgeSources!.sheet1!.contentHash).toBe('h1')
  })
})

describe('資料清單／明細帶得出新的兩格（給畫面用）', () => {
  it('gsheetExcludedTitles、blockedPendingDeletes 有值照給、沒有給預設', () => {
    expect(docToSourceSummary('x', { gsheetExcludedTitles: ['A', ' '], blockedPendingDeletes: 7 } as any))
      .toMatchObject({ gsheetExcludedTitles: ['A'], blockedPendingDeletes: 7 })
    expect(docToSourceSummary('x', {} as any)).toMatchObject({ gsheetExcludedTitles: [], blockedPendingDeletes: 0 })
  })
})
