/**
 * C-42 gsheet 同步的大量刪除守門 + 軟刪除。
 *
 * 為什麼：試算表誤刪 90/100 列（篩選後全選刪、分頁讀空）→ 下一輪自動同步照單全刪，
 * 而且成功不推播＝整批知識無聲消失。守門把「一次少太多列」擋下交人工確認；
 * 真的要刪也只是進回收桶（軟刪除），30 天內可還原。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }), delete: () => ({ __op: 'del' }) },
  Timestamp: { fromMillis: (ms: number) => ({ __ts: ms }) },
}))

const { readGoogleSheetAsCards } = vi.hoisted(() => ({ readGoogleSheetAsCards: vi.fn() }))
vi.mock('./google-sheets', () => ({
  readGoogleSheetAsCards,
  normTitle: (s: string) => String(s || '').replace(/\s+/g, '').toLowerCase(),
  parseGoogleSheetUrl: () => null,
}))

const { createKnowledgeChunk, updateKnowledgeChunk } = vi.hoisted(() => ({
  createKnowledgeChunk: vi.fn(async () => ({ status: 'indexed' })),
  updateKnowledgeChunk: vi.fn(async () => ({ status: 'indexed' })),
}))
vi.mock('./ai-knowledge-chunks', () => ({
  createKnowledgeChunk,
  updateKnowledgeChunk,
  buildChunkSoftDeletePatch: (s?: unknown) => ({ __softDelete: s ?? true }),
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
}))
vi.mock('./ai-knowledge-chunker', () => ({
  enrichCardsWithLlm: vi.fn(async (cards: unknown[]) => ({
    items: (cards as unknown[]).map(() => ({ questions: [], tags: [] })),
    inputTokens: 0,
    outputTokens: 0,
  })),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-overview', () => ({ regenerateOverviewCard: vi.fn(async () => {}) }))

const { listChunksBySource } = vi.hoisted(() => ({ listChunksBySource: vi.fn() }))
vi.mock('./ai-knowledge-sources', () => ({
  listChunksBySource,
  countSourceChunks: vi.fn(async () => 0),
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
}))

import { shouldBlockSheetDeletion, syncGoogleSheetSource } from './gsheet-sync'

describe('shouldBlockSheetDeletion（純函式）', () => {
  it('絕對張數 >10 一律擋', () => {
    expect(shouldBlockSheetDeletion(100, 11)).toBe(true)
    expect(shouldBlockSheetDeletion(1000, 11)).toBe(true)
  })
  it('比例 >30% 且來源 ≥4 卡才擋（小來源刪 2/3 張是真意圖、損害小）', () => {
    expect(shouldBlockSheetDeletion(10, 4)).toBe(true) // 40%
    expect(shouldBlockSheetDeletion(10, 3)).toBe(false) // 30% 整不超過
    expect(shouldBlockSheetDeletion(3, 2)).toBe(false) // 小來源不吃比例
  })
  it('沒刪東西不擋', () => {
    expect(shouldBlockSheetDeletion(100, 0)).toBe(false)
  })
})

/** 假 db：記錄所有 doc 更新/刪除；來源 doc 的 update 也收進來 */
function makeDb() {
  const ops: Array<{ col: string; id: string; op: string; payload?: unknown }> = []
  const db: any = {
    collection: (col: string) => ({
      doc: (id: string) => ({
        update: async (payload: unknown) => { ops.push({ col, id, op: 'update', payload }) },
        delete: async () => { ops.push({ col, id, op: 'delete' }) },
      }),
    }),
  }
  return { db, ops }
}

function seedExisting(n: number) {
  // n 張既有卡：標題 t0..t(n-1)
  listChunksBySource.mockResolvedValue(Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    title: `t${i}`,
    content: `內容${i}`,
    tags: [],
    questions: [],
    status: 'indexed',
    isOverview: false,
    manuallyEditedAtMs: 0,
    updatedAtMs: 0,
    activeUntilMs: 0,
    expiredAtMs: 0,
  })))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('syncGoogleSheetSource 大量刪除守門', () => {
  const source = { url: '', gsheetId: 'sheet1', gsheetGid: null, contentHash: 'old' } as any

  it('表格一次少 90/100 列 → blocked，一個字都不寫（含 contentHash）', async () => {
    seedExisting(100)
    readGoogleSheetAsCards.mockResolvedValue({
      cards: Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, content: `內容${i}`, tags: [] })),
      stats: {},
      warnings: [],
    })
    const { db, ops } = makeDb()
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', source)
    expect(r.outcome).toBe('blocked_mass_deletion')
    expect(r.pendingDeletes).toBe(90)
    expect(ops).toHaveLength(0) // 什麼都沒動：半套半不套會吞變動
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
    expect(updateKnowledgeChunk).not.toHaveBeenCalled()
  })

  it('帶 allowMassDeletion 放行 → 刪除走軟刪除（進回收桶），不是真刪', async () => {
    seedExisting(100)
    readGoogleSheetAsCards.mockResolvedValue({
      cards: Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, content: `內容${i}`, tags: [] })),
      stats: {},
      warnings: [],
    })
    const { db, ops } = makeDb()
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', source, { allowMassDeletion: true })
    expect(r.outcome).toBe('synced')
    expect(r.deleted).toBe(90)
    const chunkOps = ops.filter(o => o.col === 'knowledgeChunks')
    expect(chunkOps.every(o => o.op === 'update')).toBe(true) // 全是軟刪 patch
    expect(chunkOps).toHaveLength(90)
    expect((chunkOps[0]!.payload as any).__softDelete).toBeTruthy()
  })

  it('正常小幅變動（刪 2/100）不觸發守門', async () => {
    seedExisting(100)
    readGoogleSheetAsCards.mockResolvedValue({
      cards: Array.from({ length: 98 }, (_, i) => ({ title: `t${i}`, content: `內容${i}`, tags: [] })),
      stats: {},
      warnings: [],
    })
    const { db, ops } = makeDb()
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', source)
    expect(r.outcome).toBe('synced')
    expect(r.deleted).toBe(2)
    // 來源 doc 有更新 contentHash（正常完成路徑）
    expect(ops.some(o => o.col === 'knowledgeSources' && o.op === 'update')).toBe(true)
  })
})
