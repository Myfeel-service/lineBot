/**
 * gsheet 同步要守知識量額度（`C-296` 審查，2026-10-11）。
 *
 * 為什麼：匯入可以「先收放得下的前 N 條」，那樣建出來的來源 contentHash 是空的——
 * 第一輪同步就把沒收的列全部建出來，而同步以前完全不看額度，等於繞過方案上限。
 * 修好之後：新增最多建到滿、沒建的記成 quotaSkipped／quotaSkippedCount；
 * 還有沒收的時候，「表格沒變就跳過」要先看額度——空出位置就補收，還是滿的就安靜跳過（不洗紀錄）。
 */
import { createHash } from 'node:crypto'
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
const { enrichCardsWithLlm } = vi.hoisted(() => ({
  enrichCardsWithLlm: vi.fn(async (cards: unknown[]) => ({
    items: (cards as unknown[]).map(() => ({ questions: [], tags: [] })),
    inputTokens: 0,
    outputTokens: 0,
  })),
}))
vi.mock('./ai-knowledge-chunker', () => ({ enrichCardsWithLlm }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
const { regenerateOverviewCard } = vi.hoisted(() => ({ regenerateOverviewCard: vi.fn(async () => {}) }))
vi.mock('./ai-overview', () => ({ regenerateOverviewCard }))

const { getKnowledgeChunkQuota, invalidateKnowledgeChunkCount } = vi.hoisted(() => ({
  getKnowledgeChunkQuota: vi.fn(),
  invalidateKnowledgeChunkCount: vi.fn(),
}))
// 「算不算額度」那一把尺用真的（chunkCountsTowardQuota，2026-10-12 收成一份），其餘假造
vi.mock('./ai-knowledge-quota', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-knowledge-quota')>()),
  getKnowledgeChunkQuota,
  invalidateKnowledgeChunkCount,
}))

const { listChunksBySource } = vi.hoisted(() => ({ listChunksBySource: vi.fn() }))
vi.mock('./ai-knowledge-sources', () => ({
  listChunksBySource,
  countSourceChunks: vi.fn(async () => 0),
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
}))

import { syncGoogleSheetSource } from './gsheet-sync'

/** 寫入的先後順序：db 的 update 跟 createKnowledgeChunk 共用一個流水號 */
let seq = 0
let createSeq: number[] = []

/** 假 db：記下每一筆寫入（照順序），來源 doc 的 update 也收進來。讀來源一律「還在」（撞刪除另見 gsheet-sync.race.test.ts） */
function makeDb() {
  const ops: Array<{ col: string; id: string; op: string; seq: number; payload?: Record<string, unknown> }> = []
  const db: any = {
    collection: (col: string) => ({
      doc: (id: string) => ({
        get: async () => ({ exists: true, data: () => ({ workspaceId: 'ws1' }) }),
        update: async (payload: Record<string, unknown>) => { ops.push({ col, id, op: 'update', seq: seq++, payload }) },
      }),
    }),
  }
  return { db, ops }
}

const card = (t: string, content = `內容${t}`) => ({ title: t, content, tags: [] })
const chunk = (t: string, content = `內容${t}`) => ({
  id: `c-${t}`, title: t, content, tags: [], questions: [], status: 'indexed', isOverview: false,
  manuallyEditedAtMs: 0, updatedAtMs: 0, activeUntilMs: 0, expiredAtMs: 0,
})
const sheetOf = (titles: string[]) => ({ cards: titles.map(t => card(t)), stats: {}, warnings: [] })
const sourceDoc = (ops: ReturnType<typeof makeDb>['ops']) => ops.filter(o => o.col === 'knowledgeSources').at(-1)!.payload!
const created = () => createKnowledgeChunk.mock.calls.map(c => (c as unknown as [unknown, { title: string }])[1].title)

beforeEach(() => {
  vi.clearAllMocks()
  createSeq = []
  createKnowledgeChunk.mockImplementation(async () => {
    createSeq.push(seq++)
    return { status: 'indexed' }
  })
})

describe('syncGoogleSheetSource 守知識量額度', () => {
  it('匯入時只收了前 2 條（contentHash 空的）→ 第一輪同步最多建到額度滿，照表上順序，其餘記下來', async () => {
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A', 'B', 'C', 'D', 'E']))
    listChunksBySource.mockResolvedValue([chunk('A'), chunk('B')])
    getKnowledgeChunkQuota.mockResolvedValue({ used: 49, limit: 50, planName: '入門' }) // 只剩 1 個位置
    const { db, ops } = makeDb()
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: '' } as any)
    expect(created()).toEqual(['C'])
    expect(r).toMatchObject({ outcome: 'synced', added: 1, quotaSkipped: 2 })
    expect(sourceDoc(ops).quotaSkippedCount).toBe(2)
    // 沒建的列不替它們花錢補問法
    expect((enrichCardsWithLlm.mock.calls[0]![0] as Array<{ title: string }>).map(c => c.title)).toEqual(['C'])
  })

  it('同一輪刪掉的卡空出的位置可以給新的列用（先刪再建）', async () => {
    // 表上：A 留著、OLD 刪掉、N1 N2 新增；額度已滿（0 個位置），但 OLD 進回收桶後空出 1 個
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A', 'N1', 'N2']))
    listChunksBySource.mockResolvedValue([chunk('A'), chunk('OLD')])
    getKnowledgeChunkQuota.mockResolvedValue({ used: 50, limit: 50, planName: '入門' })
    const { db, ops } = makeDb()
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: 'old' } as any, { allowMassDeletion: true })
    expect(r).toMatchObject({ added: 1, deleted: 1, quotaSkipped: 1 })
    expect(created()).toEqual(['N1'])
    // 寫入順序：先軟刪 OLD，才建 N1（建卡走 createKnowledgeChunk、軟刪走 db，兩邊的呼叫順序對一下）
    const softDelete = ops.find(o => o.col === 'knowledgeChunks' && o.id === 'c-OLD')!
    expect(softDelete.seq).toBeLessThan(createSeq[0]!)
    expect(invalidateKnowledgeChunkCount).toHaveBeenCalledWith('ws1')
  })

  it('⛔ 這一輪刪掉的是草稿 → 空不出位置（草稿本來就沒算額度；2026-10-12 code review：四處算法不一致）', async () => {
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A', 'N1', 'N2']))
    listChunksBySource.mockResolvedValue([chunk('A'), { ...chunk('OLD'), status: 'draft' }])
    getKnowledgeChunkQuota.mockResolvedValue({ used: 50, limit: 50, planName: '入門' })
    const { db } = makeDb()
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: 'old' } as any, { allowMassDeletion: true })
    expect(r).toMatchObject({ added: 0, deleted: 1, quotaSkipped: 2 })
  })

  it('更新照常套用，不受額度影響', async () => {
    readGoogleSheetAsCards.mockResolvedValue({ cards: [card('A', '新內容'), card('NEW')], stats: {}, warnings: [] })
    listChunksBySource.mockResolvedValue([chunk('A')])
    getKnowledgeChunkQuota.mockResolvedValue({ used: 50, limit: 50, planName: '入門' })
    const { db, ops } = makeDb()
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: 'old' } as any)
    expect(r).toMatchObject({ outcome: 'synced', added: 0, updated: 1, quotaSkipped: 1 })
    expect(updateKnowledgeChunk).toHaveBeenCalledTimes(1)
    expect(sourceDoc(ops).quotaSkippedCount).toBe(1)
  })

  it('⛔ 還有沒收的列時，表格沒變也不能直接跳過：額度空出來（刪了卡、升級）就補收，收完把數字清成 0', async () => {
    const sheet = sheetOf(['A', 'B', 'C'])
    readGoogleSheetAsCards.mockResolvedValue(sheet)
    listChunksBySource.mockResolvedValue([chunk('A')])
    // 第一輪：滿了，B、C 沒收
    getKnowledgeChunkQuota.mockResolvedValue({ used: 50, limit: 50, planName: '入門' })
    const first = makeDb()
    const r1 = await syncGoogleSheetSource(first.db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: '' } as any)
    expect(r1.quotaSkipped).toBe(2)
    const hash = sourceDoc(first.ops).contentHash as string

    // 第二輪：表格沒變、額度空出 5 個 → 補收 B、C
    vi.clearAllMocks()
    readGoogleSheetAsCards.mockResolvedValue(sheet)
    listChunksBySource.mockResolvedValue([chunk('A')])
    getKnowledgeChunkQuota.mockResolvedValue({ used: 45, limit: 50, planName: '入門' })
    const second = makeDb()
    const r2 = await syncGoogleSheetSource(second.db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: hash, quotaSkippedCount: 2 } as any)
    expect(r2).toMatchObject({ outcome: 'synced', added: 2, quotaSkipped: 0 })
    expect(created()).toEqual(['B', 'C'])
    expect(sourceDoc(second.ops).quotaSkippedCount).toBe(0)
  })

  it('還有沒收的列、但額度還是滿的 → 當成「沒變」：不重讀卡片、不建卡、不補問法、不重做總覽，只戳時間', async () => {
    const sheet = sheetOf(['A', 'B', 'C'])
    readGoogleSheetAsCards.mockResolvedValue(sheet)
    listChunksBySource.mockResolvedValue([chunk('A')])
    getKnowledgeChunkQuota.mockResolvedValue({ used: 50, limit: 50, planName: '入門' })
    const first = makeDb()
    await syncGoogleSheetSource(first.db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: '' } as any)
    const hash = sourceDoc(first.ops).contentHash as string

    vi.clearAllMocks()
    readGoogleSheetAsCards.mockResolvedValue(sheet)
    getKnowledgeChunkQuota.mockResolvedValue({ used: 50, limit: 50, planName: '入門' })
    const { db, ops } = makeDb()
    const r = await syncGoogleSheetSource(db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: hash, quotaSkippedCount: 2, generateOverview: true } as any)
    expect(r).toMatchObject({ outcome: 'unchanged', added: 0, quotaSkipped: 2 })
    expect(listChunksBySource).not.toHaveBeenCalled()
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
    expect(enrichCardsWithLlm).not.toHaveBeenCalled()
    expect(regenerateOverviewCard).not.toHaveBeenCalled()
    expect(ops).toHaveLength(1)
    // 不動 quotaSkippedCount。欄名（`C-423`）跟時間同一次寫：機器人模組切「某一格」要用，上線前建的來源靠這裡補上
    expect(Object.keys(ops[0]!.payload!)).toEqual(['lastFetchedAt', 'gsheetFieldHeaders'])
  })

  it('沒有少收過的來源：表格沒變照舊直接跳過，連額度都不去數（平常同步不多讀）', async () => {
    const sheet = sheetOf(['A'])
    readGoogleSheetAsCards.mockResolvedValue(sheet)
    listChunksBySource.mockResolvedValue([chunk('A')])
    const first = makeDb()
    getKnowledgeChunkQuota.mockResolvedValue({ used: 1, limit: 50, planName: '入門' })
    await syncGoogleSheetSource(first.db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: '' } as any)
    const hash = sourceDoc(first.ops).contentHash as string
    vi.clearAllMocks()
    readGoogleSheetAsCards.mockResolvedValue(sheet)
    const r = await syncGoogleSheetSource(makeDb().db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: hash } as any)
    expect(r.outcome).toBe('unchanged')
    expect(r.quotaSkipped).toBeUndefined()
    expect(getKnowledgeChunkQuota).not.toHaveBeenCalled()
  })

  it('不限張數的方案（limit null）、讀不到方案（fail-open）→ 跟以前一樣全部建', async () => {
    for (const quota of [{ used: 9999, limit: null, planName: '企業' }, null]) {
      vi.clearAllMocks()
      readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A', 'B', 'C']))
      listChunksBySource.mockResolvedValue([])
      getKnowledgeChunkQuota.mockResolvedValue(quota)
      const { db, ops } = makeDb()
      const r = await syncGoogleSheetSource(db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: '' } as any)
      expect(r).toMatchObject({ added: 3, quotaSkipped: 0 })
      expect(sourceDoc(ops).quotaSkippedCount).toBe(0)
    }
  })

  it('讀方案丟錯也放行（同 assertKnowledgeChunkQuota 的 fail-open），不讓同步整個失敗', async () => {
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(['A', 'B']))
    listChunksBySource.mockResolvedValue([])
    getKnowledgeChunkQuota.mockRejectedValue(new Error('billing down'))
    const r = await syncGoogleSheetSource(makeDb().db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: '' } as any)
    expect(r).toMatchObject({ added: 2, quotaSkipped: 0 })
  })
})

describe('內容指紋跟改版前一模一樣（finding 13：NUL 位元組改成跳脫字）', () => {
  it('同一份卡片算出來的 contentHash 等於改前（檔案裡是真的 NUL／0x01 位元組）算出來的值', async () => {
    // 這個值是用改前的 gsheet-sync.ts（git HEAD 14f2b67）的 cardsHash 實際算出來的；
    // 指紋一變，每一份試算表下一輪都會整份重新比對（還可能重做總覽、重補問法）
    const PINNED = 'e91e35f6228812a3d57ec12b3db18d6a726c0121c570c0954de8c905ed4b50a8'
    readGoogleSheetAsCards.mockResolvedValue({
      cards: [card('W1', '容量：12L\n價格：12,900'), card('退貨?', '7 天內')],
      stats: {},
      warnings: [],
    })
    listChunksBySource.mockResolvedValue([])
    getKnowledgeChunkQuota.mockResolvedValue(null)
    const { db, ops } = makeDb()
    await syncGoogleSheetSource(db, 'ws1', 'src1', { url: '', gsheetId: 's', gsheetGid: null, contentHash: '' } as any)
    expect(sourceDoc(ops).contentHash).toBe(PINNED)
    // 跳脫字寫法本身也對得上（防有人把分隔字「順手」換掉）
    const norm = ['W1\u0000容量：12L\n價格：12,900', '退貨?\u00007 天內'].sort().join('\u0001')
    expect(createHash('sha256').update(norm).digest('hex')).toBe(PINNED)
  })
})
