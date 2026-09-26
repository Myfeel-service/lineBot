/**
 * `C-250`③「等你看過」（draft）的卡不會沒點頭就上線。
 *
 * 為什麼要有：draft 的卡**有向量**（試答讀得到），而建卡、改字、重建索引、全量重建、還原
 * 五條路都會經過 runIndexOnChunk／updateKnowledgeChunk／resolveRestoredStatus——
 * 任何一條把它寫成 indexed，就是「沒看過的卡直接對客人講話」。點頭只能走 drafts/adopt。
 * 同 `ai-knowledge-chunks.disabled-guard.test.ts` 那一套（停用卡不復活）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __op: 'ts' }),
    delete: () => ({ __op: 'del' }),
    vector: (v: number[]) => ({ __op: 'vec', v }),
    increment: (n: number) => ({ __op: 'inc', n }),
  },
  Timestamp: { fromMillis: (ms: number) => ({ __ts: ms }) },
}))

const { embedDocument } = vi.hoisted(() => ({ embedDocument: vi.fn() }))
vi.mock('./gemini', () => ({
  embedDocument,
  estimateTokens: (t: string) => t.length,
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-product-alias', () => ({
  getProductAliases: vi.fn(async () => ({ aliases: {} })),
  canonicalProductName: (s: string) => s,
}))

import { createKnowledgeChunk, resolveRestoredStatus, runIndexOnChunk, updateKnowledgeChunk } from './ai-knowledge-chunks'

function makeChunkDb(initial: Record<string, any>) {
  const store: Record<string, any> = structuredClone(initial)
  const writes: Array<{ id: string, payload: Record<string, any> }> = []
  const db: any = {
    collection: () => ({
      doc: (id: string) => ({
        get: async () => ({ exists: store[id] != null, data: () => store[id] }),
        set: async (payload: Record<string, any>) => {
          writes.push({ id, payload })
          store[id] = { ...payload }
        },
        update: async (payload: Record<string, any>) => {
          writes.push({ id, payload })
          store[id] = { ...(store[id] ?? {}), ...payload }
        },
      }),
    }),
  }
  return { db, store, writes }
}

beforeEach(() => {
  embedDocument.mockReset()
  embedDocument.mockResolvedValue([0.1, 0.2])
})

describe('建卡：draft 從頭到尾都不是 pending／indexed', () => {
  it('⛔ 第一筆寫入就是 draft（寫 pending 的話排程 5 分鐘內會把它推成 indexed）', async () => {
    const { db, store, writes } = makeChunkDb({})
    const r = await createKnowledgeChunk(db, { workspaceId: 'ws1', chunkId: 'c1', title: '黑豆水', content: '一瓶 180', tags: [], draft: true })
    expect(writes[0]!.payload.status).toBe('draft')
    expect(r.status).toBe('draft')
    expect(store.c1.status).toBe('draft')
    // 向量照算（試答讀得到）
    expect(store.c1.embedding).toEqual({ __op: 'vec', v: [0.1, 0.2] })
  })

  it('向量沒算成也還是 draft（⛔ 落 failed 會被排程重試成 indexed）', async () => {
    embedDocument.mockRejectedValue(new Error('Gemini 502'))
    const { db, store } = makeChunkDb({})
    const r = await createKnowledgeChunk(db, { workspaceId: 'ws1', chunkId: 'c1', title: 'A', content: 'a', tags: [], draft: true })
    expect(r.status).toBe('draft')
    expect(store.c1.status).toBe('draft')
    expect(store.c1.retryCount).toBeUndefined()
  })

  it('一般建卡照舊 pending → indexed（回歸）', async () => {
    const { db, writes, store } = makeChunkDb({})
    await createKnowledgeChunk(db, { workspaceId: 'ws1', chunkId: 'c1', title: 'A', content: 'a', tags: [] })
    expect(writes[0]!.payload.status).toBe('pending')
    expect(store.c1.status).toBe('indexed')
  })
})

describe('重建索引、改字、還原：都不等於點頭', () => {
  it('runIndexOnChunk（單卡重建／全量重建）→ 仍是 draft', async () => {
    const { db, store } = makeChunkDb({ c1: { status: 'draft', title: 'A', sourceId: null } })
    expect((await runIndexOnChunk(db, 'c1', 'a')).status).toBe('draft')
    expect(store.c1.status).toBe('draft')
  })

  it('在審卡時改了字 → 中繼寫入不是 pending、最後仍是 draft', async () => {
    const { db, store, writes } = makeChunkDb({
      c1: { status: 'draft', workspaceId: 'ws1', title: '舊', content: '舊', questions: [], sourceId: null },
    })
    const r = await updateKnowledgeChunk(db, { chunkId: 'c1', title: '新', content: '新', tags: [], contentChanged: true, manualEdit: true })
    expect(writes.find(w => w.payload.embedding === null)!.payload.status).toBe('draft')
    expect(r.status).toBe('draft')
    expect(store.c1.status).toBe('draft')
    expect(store.c1.content).toBe('新')
  })

  it('從回收桶還原 → 回到 draft（還原＝撤銷刪除，不是點頭）', () => {
    expect(resolveRestoredStatus('draft', true)).toBe('draft')
    expect(resolveRestoredStatus('draft', false)).toBe('draft')
  })
})
