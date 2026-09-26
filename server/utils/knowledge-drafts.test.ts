/**
 * 「等你看過」的卡：點頭、刪掉（`C-250`③）。
 *
 * ⭐ 最要守的是額度那一條：原本額度守門是「現有＋這批 > 上限 → 整批 403」，
 *    新帳號開帳整理出 70 張＝一張都拿不到，訊息還叫他「刪掉不需要的」（他沒東西可刪）。
 *    現在是**收到滿為止**，沒收的照實回傳。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) } }))
vi.mock('./firebase', () => ({ getDb: () => { throw new Error('test 必須自帶 db') } }))
const { getKnowledgeChunkQuota, runIndexOnChunk, countSourceChunks } = vi.hoisted(() => ({
  getKnowledgeChunkQuota: vi.fn(),
  runIndexOnChunk: vi.fn(async () => ({ status: 'indexed' })),
  countSourceChunks: vi.fn(async () => 0),
}))
vi.mock('./ai-knowledge-quota', () => ({ getKnowledgeChunkQuota, invalidateKnowledgeChunkCount: vi.fn() }))
vi.mock('./ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  buildEmbeddingText: (t: string, c: string) => `${t}\n${c}`,
  runIndexOnChunk,
}))
vi.mock('./ai-knowledge-sources', () => ({ KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources', countSourceChunks }))
vi.mock('./store-profile-jobs', () => ({ getSiteCardsJobId: vi.fn(async () => ''), loadStoreProfileJob: vi.fn(async () => null) }))

import { adoptDrafts, dismissDrafts } from './knowledge-drafts'

function makeDb(docs: Record<string, Record<string, any>>, sources: Record<string, Record<string, any>> = {}) {
  const store = { knowledgeChunks: structuredClone(docs), knowledgeSources: structuredClone(sources) } as Record<string, Record<string, any>>
  const deleted: string[] = []
  const ref = (col: string, id: string) => ({
    id,
    get: async () => ({ id, exists: store[col]![id] != null, data: () => store[col]![id], ref: ref(col, id) }),
    update: async (p: Record<string, any>) => { store[col]![id] = { ...store[col]![id], ...p } },
    delete: async () => { deleted.push(`${col}/${id}`); delete store[col]![id] },
  })
  const db: any = {
    collection: (col: string) => ({ doc: (id: string) => ref(col, id) }),
    getAll: async (...refs: any[]) => Promise.all(refs.map(r => r.get())),
    batch: () => {
      const ops: Array<() => Promise<void>> = []
      return { delete: (r: any) => ops.push(() => r.delete()), commit: async () => { for (const op of ops) await op() } }
    },
  }
  return { db, store, deleted }
}

const draft = (extra: Record<string, any> = {}) => ({ workspaceId: 'ws1', status: 'draft', title: 'T', content: 'C', questions: [], embedding: { v: 1 }, sourceId: 's1', ...extra })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('點頭（adoptDrafts）', () => {
  it('⭐ 額度不夠：收到滿為止，剩下的照實回傳（⛔ 不再整批 403）', async () => {
    getKnowledgeChunkQuota.mockResolvedValue({ used: 48, limit: 50, planName: '免費' })
    const { db, store } = makeDb({ a: draft(), b: draft(), c: draft(), d: draft() })
    const r = await adoptDrafts('ws1', ['a', 'b', 'c', 'd'], db)
    expect(r.adopted).toEqual(['a', 'b'])
    expect(r.leftForQuota).toEqual(['c', 'd'])
    expect(store.knowledgeChunks!.a!.status).toBe('indexed')
    expect(store.knowledgeChunks!.c!.status).toBe('draft')
  })

  it('不限張數的方案全收；方案讀不到也不擋（跟既有守門同一個 fail-open）', async () => {
    getKnowledgeChunkQuota.mockResolvedValue({ used: 999, limit: null, planName: '企業' })
    const { db } = makeDb({ a: draft(), b: draft() })
    expect((await adoptDrafts('ws1', ['a', 'b'], db)).adopted).toHaveLength(2)
    getKnowledgeChunkQuota.mockResolvedValue(null)
    const { db: db2 } = makeDb({ a: draft() })
    expect((await adoptDrafts('ws1', ['a'], db2)).adopted).toEqual(['a'])
  })

  it('⛔ 別家的、已經不是等你看過的都不碰（重按、別的分頁先按了）', async () => {
    getKnowledgeChunkQuota.mockResolvedValue({ used: 0, limit: 50, planName: '免費' })
    const { db, store } = makeDb({ a: draft({ workspaceId: 'other' }), b: draft({ status: 'indexed' }), c: draft() })
    const r = await adoptDrafts('ws1', ['a', 'b', 'c', 'missing'], db)
    expect(r.adopted).toEqual(['c'])
    expect(r.skipped.sort()).toEqual(['a', 'b', 'missing'])
    expect(store.knowledgeChunks!.a!.status).toBe('draft')
  })

  it('整理時向量沒算成的：先落 pending 再當場補算（⛔ 不可以沒有向量就標 indexed）', async () => {
    getKnowledgeChunkQuota.mockResolvedValue({ used: 0, limit: 50, planName: '免費' })
    const { db, store } = makeDb({ a: draft({ embedding: null }) })
    await adoptDrafts('ws1', ['a'], db)
    expect(runIndexOnChunk).toHaveBeenCalledTimes(1)
    expect(store.knowledgeChunks!.a!.status).toBe('pending')
  })
})

describe('刪掉（dismissDrafts）', () => {
  it('真刪；那一頁刪光了，開帳整理出來的那份資料也收掉', async () => {
    countSourceChunks.mockResolvedValue(0)
    const { db, deleted } = makeDb({ a: draft() }, { s1: { workspaceId: 'ws1', origin: 'onboarding-site' } })
    const r = await dismissDrafts('ws1', ['a'], db)
    expect(r.dismissed).toEqual(['a'])
    expect(deleted).toContain('knowledgeChunks/a')
    expect(deleted).toContain('knowledgeSources/s1')
  })

  it('⛔ 店家自己建的資料就算 0 張也不刪；已經採用的卡刪不到（走原本的回收桶）', async () => {
    countSourceChunks.mockResolvedValue(0)
    const { db, deleted } = makeDb({ a: draft({ sourceId: 's2' }), b: draft({ status: 'indexed' }) }, { s2: { workspaceId: 'ws1' } })
    const r = await dismissDrafts('ws1', ['a', 'b'], db)
    expect(r.dismissed).toEqual(['a'])
    expect(r.skipped).toEqual(['b'])
    expect(deleted).not.toContain('knowledgeSources/s2')
    expect(deleted).not.toContain('knowledgeChunks/b')
  })
})
