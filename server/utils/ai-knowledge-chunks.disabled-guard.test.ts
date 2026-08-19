/**
 * C-41 停用卡不復活的守門。
 *
 * 為什麼要有這批測試：健檢抓到四條路（補問法 / gsheet 同步 / 單卡重建索引 / 編輯存檔）
 * 都會把停用（含到期下架）的卡無聲寫回 indexed——過期募資價直接復活對客人講話。
 * 守門收斂在兩點：updateKnowledgeChunk 不把 disabled 洗成 pending、
 * runIndexOnChunk 成功/失敗都維持 disabled。這批測試對兩點各自驗「拿掉就紅」。
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

import { chunkStillActive, runIndexOnChunk, updateKnowledgeChunk } from './ai-knowledge-chunks'

/** 假 Firestore：單 collection 記憶體版，update 淺合併讓「先寫狀態、後續讀到」的時序真實 */
function makeChunkDb(initial: Record<string, any>) {
  const store: Record<string, any> = structuredClone(initial)
  const updates: Array<{ id: string; payload: Record<string, any> }> = []
  const db: any = {
    collection: () => ({
      doc: (id: string) => ({
        get: async () => ({ exists: store[id] != null, data: () => store[id] }),
        update: async (payload: Record<string, any>) => {
          updates.push({ id, payload })
          store[id] = { ...(store[id] ?? {}), ...payload }
        },
      }),
    }),
  }
  return { db, store, updates }
}

beforeEach(() => {
  embedDocument.mockReset()
  embedDocument.mockResolvedValue([0.1, 0.2])
})

describe('runIndexOnChunk 守門：停用卡不復活', () => {
  it('停用卡 embed 成功 → 狀態維持 disabled（向量照更新，重新啟用免重算）', async () => {
    const { db, updates } = makeChunkDb({
      c1: { status: 'disabled', title: '募資倒數卡', sourceId: null },
    })
    const res = await runIndexOnChunk(db, 'c1', '募資倒數卡\n內容')
    expect(res.status).toBe('disabled')
    const final = updates.at(-1)!.payload
    expect(final.status).toBe('disabled')
    expect(final.embedding).toEqual({ __op: 'vec', v: [0.1, 0.2] })
  })

  it('停用卡 embed 失敗 → 不落 failed（落了會進 retry 佇列、重試成功即復活）、不動 retryCount', async () => {
    embedDocument.mockRejectedValue(new Error('Gemini 502'))
    const { db, updates } = makeChunkDb({
      c1: { status: 'disabled', title: '募資倒數卡', sourceId: null },
    })
    const res = await runIndexOnChunk(db, 'c1', 'x')
    expect(res.status).toBe('disabled')
    const final = updates.at(-1)!.payload
    expect(final.status).toBe('disabled')
    expect(final.retryCount).toBeUndefined()
    expect(final.failureReason).toContain('502')
  })

  it('一般 pending 卡照舊：成功 indexed、失敗 failed + retryCount（守門不影響正常路）', async () => {
    const { db, updates } = makeChunkDb({
      ok: { status: 'pending', title: 'A', sourceId: null },
      bad: { status: 'pending', title: 'B', sourceId: null },
    })
    expect((await runIndexOnChunk(db, 'ok', 'a')).status).toBe('indexed')
    expect(updates.at(-1)!.payload.status).toBe('indexed')

    embedDocument.mockRejectedValue(new Error('boom'))
    expect((await runIndexOnChunk(db, 'bad', 'b')).status).toBe('failed')
    const final = updates.at(-1)!.payload
    expect(final.status).toBe('failed')
    expect(final.retryCount).toEqual({ __op: 'inc', n: 1 })
  })
})

describe('updateKnowledgeChunk：內容更新不等於重新啟用', () => {
  it('停用卡改內容（gsheet 同步 / 編輯存檔的形狀）→ 中繼寫入保持 disabled、最終仍 disabled', async () => {
    const { db, store, updates } = makeChunkDb({
      c1: {
        status: 'disabled',
        workspaceId: 'ws1',
        title: '舊標題',
        content: '舊內容',
        questions: [],
        sourceId: null,
      },
    })
    const res = await updateKnowledgeChunk(db, {
      chunkId: 'c1',
      title: '新標題',
      content: '新內容',
      tags: [],
      contentChanged: true,
      manualEdit: false,
    })
    // 中繼那筆（清向量、標狀態）絕不能是 pending——是 pending 的話守門讀不到 disabled
    const intermediate = updates.find(u => u.payload.embedding === null)!
    expect(intermediate.payload.status).toBe('disabled')
    expect(res.status).toBe('disabled')
    expect(store.c1.status).toBe('disabled')
    expect(store.c1.title).toBe('新標題') // 內容照樣更新，只是不上架
  })

  it('一般卡改內容照舊走 pending → indexed（回歸）', async () => {
    const { db, store } = makeChunkDb({
      c1: {
        status: 'indexed',
        workspaceId: 'ws1',
        title: '舊',
        content: '舊',
        questions: [],
        sourceId: null,
      },
    })
    const res = await updateKnowledgeChunk(db, {
      chunkId: 'c1',
      title: '新',
      content: '新',
      tags: [],
      contentChanged: true,
    })
    expect(res.status).toBe('indexed')
    expect(store.c1.status).toBe('indexed')
  })
})

describe('chunkStillActive：兩條檢索路共用的到期保險', () => {
  const now = 1_700_000_000_000
  it('沒設期限 → 有效；期限未到 → 有效；期限已過 → 排除', () => {
    expect(chunkStillActive({}, now)).toBe(true)
    expect(chunkStillActive({ activeUntil: { toMillis: () => now + 1 } }, now)).toBe(true)
    expect(chunkStillActive({ activeUntil: { toMillis: () => now } }, now)).toBe(false)
    expect(chunkStillActive({ activeUntil: { toMillis: () => now - 1 } }, now)).toBe(false)
  })
})

describe('回收桶（軟刪除）helpers', () => {
  it('buildChunkSoftDeletePatch：狀態改 disabled、記刪除前狀態、設清運期限', async () => {
    const { buildChunkSoftDeletePatch, RECYCLE_RETENTION_DAYS } = await import('./ai-knowledge-chunks')
    const p = buildChunkSoftDeletePatch('indexed') as any
    expect(p.status).toBe('disabled')
    expect(p.statusBeforeDelete).toBe('indexed')
    expect(p.deletedAt).toEqual({ __op: 'ts' })
    expect(p.purgeAfter.__ts).toBeGreaterThan(Date.now() + (RECYCLE_RETENTION_DAYS - 1) * 86_400_000)
  })

  it('resolveRestoredStatus：停用的還原後仍停用（還原≠上架）；indexed 沒向量退 pending', async () => {
    const { resolveRestoredStatus } = await import('./ai-knowledge-chunks')
    expect(resolveRestoredStatus('disabled', true)).toBe('disabled')
    expect(resolveRestoredStatus('failed', false)).toBe('failed')
    expect(resolveRestoredStatus('indexed', true)).toBe('indexed')
    expect(resolveRestoredStatus('indexed', false)).toBe('pending')
    // 舊資料沒記刪除前狀態：有向量當 indexed、沒向量當 pending
    expect(resolveRestoredStatus(undefined, true)).toBe('indexed')
    expect(resolveRestoredStatus(undefined, false)).toBe('pending')
  })
})
