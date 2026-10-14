/**
 * 試算表同步的三件事（`C-308`③⑤、`D-125`②，2026-10-13）。
 *
 * ③ 🔴 同步途中這份資料被刪掉：以前照樣一條條建下去，建出來的知識不屬於任何一份資料——
 *    AI 會用、後台看不到也刪不掉（正式站測試撞到 9 條）。現在每建一條前確認資料還在，
 *    不在了就停、把這一輪建的真刪掉、回 `source_deleted`，⛔ 不寫那份資料、不丟錯。
 * ⑤ 排程擋下大量刪除時記的 `blockedPendingDeletes`，任何一次同步成功都要寫回 0。
 * ② 他在後台刪掉的列（`gsheetExcludedTitles`）：之後同步跳過——不建、不算刪除、不算空間不夠沒收。
 * 正式庫零讀零寫：Firestore 是記憶體裡的假物件。
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

/** 假 Firestore：STORE[collection][id] */
const STORE: Record<string, Record<string, Record<string, any>>> = {}
const hooks = { afterCreate: (_n: number) => {} }

const { createKnowledgeChunk, updateKnowledgeChunk } = vi.hoisted(() => ({
  createKnowledgeChunk: vi.fn(),
  updateKnowledgeChunk: vi.fn(async () => ({ status: 'indexed' })),
}))
vi.mock('./ai-knowledge-chunks', () => ({
  createKnowledgeChunk,
  updateKnowledgeChunk,
  buildChunkSoftDeletePatch: () => ({ isDeleted: true, deletedAt: '__ts__' }),
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
vi.mock('./ai-knowledge-quota', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-knowledge-quota')>()),
  getKnowledgeChunkQuota: vi.fn(async () => ({ used: 0, limit: null, planName: '企業' })),
  invalidateKnowledgeChunkCount: vi.fn(),
}))
vi.mock('./ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  // 跟真的一樣：回收桶的不列
  listChunksBySource: vi.fn(async (_db: unknown, ws: string, sid: string) =>
    Object.entries(STORE.knowledgeChunks ?? {})
      .filter(([, d]) => d.workspaceId === ws && d.sourceId === sid && d.isDeleted !== true)
      .map(([id, d]) => ({ id, title: d.title, content: d.content, tags: [], questions: [], status: d.status ?? 'indexed', isOverview: false, manuallyEditedAtMs: 0, updatedAtMs: 0, activeUntilMs: 0, expiredAtMs: 0 }))),
  countSourceChunks: vi.fn(async () => 0),
}))

function docRef(col: string, id: string): any {
  return {
    id,
    get: async () => ({ id, exists: !!STORE[col]?.[id], data: () => STORE[col]?.[id] }),
    update: async (data: Record<string, unknown>) => {
      if (!STORE[col]?.[id]) throw Object.assign(new Error('NOT_FOUND'), { code: 5 })
      Object.assign(STORE[col][id]!, data)
    },
    delete: async () => { delete STORE[col]?.[id] },
  }
}
function query(col: string, filters: Array<[string, unknown]> = []): any {
  return {
    where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]]),
    get: async () => {
      const docs = Object.entries(STORE[col] ?? {})
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => ({ id, data: () => d, ref: docRef(col, id) }))
      return { empty: docs.length === 0, size: docs.length, docs }
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

import { syncGoogleSheetSource } from './gsheet-sync'

const sheetOf = (titles: string[]) => ({ cards: titles.map(t => ({ title: t, content: `內容${t}`, tags: [] })), stats: {}, warnings: [] })
const sourceData = (extra: Record<string, unknown> = {}) => ({ url: '', gsheetId: 's', gsheetGid: null, contentHash: 'old', ...extra }) as any
const liveTitles = () => Object.values(STORE.knowledgeChunks ?? {}).filter(d => d.isDeleted !== true).map(d => d.title).sort()

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
  STORE.knowledgeSources = { src1: { workspaceId: 'ws1', type: 'gsheet', name: '價目表' } }
  STORE.knowledgeChunks = {}
  hooks.afterCreate = () => {}
  let n = 0
  createKnowledgeChunk.mockImplementation(async (_db: unknown, p: any) => {
    STORE.knowledgeChunks![p.chunkId] = { workspaceId: p.workspaceId, sourceId: p.sourceId, title: p.title, content: p.content, status: 'indexed', isDeleted: false }
    hooks.afterCreate(++n)
    return { id: p.chunkId, status: 'indexed' }
  })
})

describe('🔴 同步途中資料被刪掉（`C-308`③）', () => {
  it('建到第 2 條時資料被刪 → 不再建第 3 條、這一輪建的全部真刪、回 source_deleted、⛔ 不寫那份資料也不丟錯', async () => {
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A', 'B', 'C', 'D']))
    // 模擬刪除那一邊：先數完名單（那時候一條都還沒有）、再刪資料文件——我們建的都不在它的名單裡
    hooks.afterCreate = (n) => { if (n === 2) delete STORE.knowledgeSources!.src1 }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', sourceData())
    expect(r.outcome).toBe('source_deleted')
    expect(createKnowledgeChunk).toHaveBeenCalledTimes(2)
    // 0 條孤兒：AI 不會拿到一條不屬於任何資料的知識
    expect(Object.keys(STORE.knowledgeChunks!)).toEqual([])
    expect(STORE.knowledgeSources!.src1).toBeUndefined() // 沒有被「同步成功」寫回來
    warn.mockRestore()
  })

  it('補問法（十幾秒）那段時間就被刪了 → 一條都不建', async () => {
    readGoogleSheetAsCards.mockImplementation(async () => {
      delete STORE.knowledgeSources!.src1
      return sheetOf(['A', 'B'])
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', sourceData())
    expect(r.outcome).toBe('source_deleted')
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('最後一條建的同時被刪（每條前的檢查看不到）→ 寫完再查一次也收得掉', async () => {
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A', 'B']))
    hooks.afterCreate = (n) => { if (n === 2) delete STORE.knowledgeSources!.src1 }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', sourceData())
    expect(r.outcome).toBe('source_deleted')
    expect(liveTitles()).toEqual([])
    warn.mockRestore()
  })

  it('資料一直都在 → 照常同步（檢查不改變平常的結果）', async () => {
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A', 'B']))
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', sourceData())
    expect(r).toMatchObject({ outcome: 'synced', added: 2 })
    expect(liveTitles()).toEqual(['A', 'B'])
  })
})

describe('排程擋下大量刪除的記號（`C-308`⑤）', () => {
  it('同步成功＝寫回 blockedPendingDeletes 0（手按「立即同步」放行也走這裡）', async () => {
    STORE.knowledgeSources!.src1!.blockedPendingDeletes = 12
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A']))
    await syncGoogleSheetSource(db, 'ws1', 'src1', sourceData({ blockedPendingDeletes: 12 }), { allowMassDeletion: true })
    expect(STORE.knowledgeSources!.src1!.blockedPendingDeletes).toBe(0)
  })

  it('表格又跟知識對得上（指紋沒變）也要清掉', async () => {
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A']))
    await syncGoogleSheetSource(db, 'ws1', 'src1', sourceData({ contentHash: '' }))
    const hash = STORE.knowledgeSources!.src1!.contentHash
    STORE.knowledgeSources!.src1!.blockedPendingDeletes = 5
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', sourceData({ contentHash: hash, blockedPendingDeletes: 5 }))
    expect(r.outcome).toBe('unchanged')
    expect(STORE.knowledgeSources!.src1!.blockedPendingDeletes).toBe(0)
  })
})

describe('在後台刪掉的列不再收（`D-125`②）', () => {
  it('名單上的列：不建、不算刪除、不算空間不夠沒收，數成 excludedSkipped（大小寫、空白不同也認得）', async () => {
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A', 'Poketomo 出貨', 'C']))
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', sourceData({ gsheetExcludedTitles: ['poketomo出貨'] }))
    expect(r).toMatchObject({ outcome: 'synced', added: 2, deleted: 0, quotaSkipped: 0, excludedSkipped: 1 })
    expect(liveTitles()).toEqual(['A', 'C'])
  })

  it('⛔ 不算「表上少了」：既有的都在、刪掉的那條在回收桶 → 不觸發大量刪除守門、也不再刪什麼', async () => {
    // 現有 4 條，其中 X 他在後台刪了（回收桶）；表上 4 列都還在
    STORE.knowledgeChunks = {
      a: { workspaceId: 'ws1', sourceId: 'src1', title: 'A', content: '內容A', isDeleted: false },
      b: { workspaceId: 'ws1', sourceId: 'src1', title: 'B', content: '內容B', isDeleted: false },
      c: { workspaceId: 'ws1', sourceId: 'src1', title: 'C', content: '內容C', isDeleted: false },
      x: { workspaceId: 'ws1', sourceId: 'src1', title: 'X', content: '內容X', isDeleted: true },
    }
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A', 'B', 'C', 'X']))
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', sourceData({ gsheetExcludedTitles: ['X'] }))
    expect(r).toMatchObject({ outcome: 'synced', added: 0, deleted: 0, excludedSkipped: 1 })
    expect(STORE.knowledgeChunks!.x!.isDeleted).toBe(true) // 沒長回來
  })

  it('表格沒變（指紋一樣）時照樣講得出跳過幾列', async () => {
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A', 'X']))
    await syncGoogleSheetSource(db, 'ws1', 'src1', sourceData({ contentHash: '', gsheetExcludedTitles: ['X'] }))
    const hash = STORE.knowledgeSources!.src1!.contentHash
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', sourceData({ contentHash: hash, gsheetExcludedTitles: ['X'] }))
    expect(r).toMatchObject({ outcome: 'unchanged', kept: 1, excludedSkipped: 1 })
  })
})
