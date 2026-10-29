/**
 * `C-429`：試算表同步時，內容有變的那幾格要拿去找「還寫著舊字的模組」。
 * 這裡只釘「同步有沒有把對的那幾格交出去」；怎麼找、怎麼記在 sheet-stale-modules.test.ts。
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
vi.mock('./ai-knowledge-chunks', () => ({
  createKnowledgeChunk: vi.fn(async () => ({ status: 'indexed' })),
  updateKnowledgeChunk: vi.fn(async () => ({ status: 'indexed' })),
  buildChunkSoftDeletePatch: (s?: unknown) => ({ __softDelete: s ?? true }),
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
}))
vi.mock('./ai-knowledge-chunker', () => ({
  enrichCardsWithLlm: vi.fn(async (cards: unknown[]) => ({ items: (cards as unknown[]).map(() => ({ questions: [], tags: [] })), inputTokens: 0, outputTokens: 0 })),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-overview', () => ({ regenerateOverviewCard: vi.fn(async () => {}) }))
vi.mock('./ai-knowledge-quota', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-knowledge-quota')>()),
  getKnowledgeChunkQuota: vi.fn(async () => ({ used: 0, limit: null, planName: '專業' })),
  invalidateKnowledgeChunkCount: vi.fn(),
}))
const { listChunksBySource } = vi.hoisted(() => ({ listChunksBySource: vi.fn() }))
vi.mock('./ai-knowledge-sources', () => ({
  listChunksBySource,
  countSourceChunks: vi.fn(async () => 0),
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
}))
const { recordStaleSheetModules } = vi.hoisted(() => ({ recordStaleSheetModules: vi.fn(async () => 0) }))
vi.mock('./sheet-stale-modules', () => ({ recordStaleSheetModules }))

import { syncGoogleSheetSource } from './gsheet-sync'

function makeDb() {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => ({ workspaceId: 'ws1' }) }),
        update: async () => {},
      }),
    }),
  } as any
}

const HEADERS = ['出貨時間', '商品頁面']
const OLD = '出貨時間：依原廠公告：\n商品將於 10 月底 依照訂單順序陸續出貨。\n商品頁面：https://a.example/GL-5680'
const NEW = '出貨時間：依原廠公告：\n第一批 10 月底，10/7 起第二批 11 月底。\n商品頁面：https://a.example/GL-5680'
const chunk = (title: string, content: string, manual = 0) => ({
  id: `c-${title}`, title, content, tags: [], questions: [], status: 'indexed', isOverview: false,
  manuallyEditedAtMs: manual, updatedAtMs: 0, activeUntilMs: 0, expiredAtMs: 0,
})
const base = { url: '', gsheetId: 's', gsheetGid: null, contentHash: 'old-hash', name: '客服（商品資訊）', gsheetFieldHeaders: HEADERS }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('`C-429` 同步時把改了的那幾格交出去找舊字', () => {
  it('⭐ 出貨時間改了：交出「哪一列、哪一格、舊的、新的」；沒改的商品頁不交', async () => {
    readGoogleSheetAsCards.mockResolvedValue({ cards: [{ title: 'Giaretti', content: NEW, tags: [] }], fieldHeaders: HEADERS, stats: {} })
    listChunksBySource.mockResolvedValue([chunk('Giaretti', OLD)])
    await syncGoogleSheetSource(makeDb(), 'ws1', 'src1', base as any)
    expect(recordStaleSheetModules).toHaveBeenCalledTimes(1)
    const [, ws, sourceId, sourceName, changes] = recordStaleSheetModules.mock.calls[0] as any[]
    expect([ws, sourceId, sourceName]).toEqual(['ws1', 'src1', '客服（商品資訊）'])
    expect(changes).toEqual([{
      row: 'Giaretti',
      field: '出貨時間',
      oldValue: '依原廠公告：\n商品將於 10 月底 依照訂單順序陸續出貨。',
      newValue: '依原廠公告：\n第一批 10 月底，10/7 起第二批 11 月底。',
    }])
  })

  it('對照組：表格沒變（指紋一樣）＝不找', async () => {
    readGoogleSheetAsCards.mockResolvedValue({ cards: [{ title: 'Giaretti', content: OLD, tags: [] }], fieldHeaders: HEADERS, stats: {} })
    listChunksBySource.mockResolvedValue([chunk('Giaretti', OLD)])
    await syncGoogleSheetSource(makeDb(), 'ws1', 'src1', { ...base, contentHash: '' } as any)
    expect(recordStaleSheetModules).not.toHaveBeenCalled()
  })

  it('對照組：那張卡在後台改過（同步不覆蓋它）＝AI 還是講舊的，不找', async () => {
    readGoogleSheetAsCards.mockResolvedValue({ cards: [{ title: 'Giaretti', content: NEW, tags: [] }], fieldHeaders: HEADERS, stats: {} })
    listChunksBySource.mockResolvedValue([chunk('Giaretti', OLD, Date.now())])
    await syncGoogleSheetSource(makeDb(), 'ws1', 'src1', base as any)
    expect(recordStaleSheetModules).not.toHaveBeenCalled()
  })
})
