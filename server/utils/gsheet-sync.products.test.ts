/**
 * `C-434`：同步跟商品清單接起來。
 * 這一組釘三個承諾：
 *   ① 只改「放進LINE目錄」的勾也算表格變了（開關不在卡片內文裡，指紋要另外算進去），不然那一小時商品目錄不會跟。
 *   ② ⛔ 沒有開關欄的表（現在所有的表），指紋一個字都不能變——變了的話上線後每一份試算表都會整份重比一次。
 *   ③ 表沒變也要跑一次商品清單（上線前就在同步的表，第一份清單靠這裡建）。
 * 商品清單本身怎麼比在 shared/sheet-products.test.ts。
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
  countSourceChunks: vi.fn(async () => 1),
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
}))
vi.mock('./sheet-stale-modules', () => ({ recordStaleSheetModules: vi.fn(async () => 0) }))
const { syncSheetProducts } = vi.hoisted(() => ({ syncSheetProducts: vi.fn(async () => []) }))
vi.mock('./sheet-products', () => ({ syncSheetProducts }))

import { syncGoogleSheetSource } from './gsheet-sync'

let updates: Array<Record<string, unknown>> = []
function makeDb() {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => ({ workspaceId: 'ws1' }) }),
        update: async (patch: Record<string, unknown>) => { updates.push(patch) },
      }),
    }),
  } as any
}

const HEADERS = ['出貨時間', '商品頁面']
const CONTENT = '出貨時間：10 月底\n商品頁面：https://a.example/GL-5680'
const card = (controls?: Record<string, string>) => ({ title: 'Giaretti', content: CONTENT, tags: [], ...(controls ? { controls } : {}) })
const chunk = { id: 'c1', title: 'Giaretti', content: CONTENT, tags: [], questions: [], status: 'indexed', isOverview: false, manuallyEditedAtMs: 0, updatedAtMs: 0, activeUntilMs: 0, expiredAtMs: 0 }
const base = { url: '', gsheetId: 's', gsheetGid: null, name: '客服（商品資訊）', gsheetFieldHeaders: HEADERS }

function sheetOf(c: ReturnType<typeof card>, controlHeaders: string[] = []) {
  return { cards: [c], fieldHeaders: HEADERS, controlHeaders, stats: {} }
}

/** 同步一次、回傳寫進來源的新指紋 */
async function syncOnce(contentHash: string) {
  updates = []
  const r = await syncGoogleSheetSource(makeDb(), 'ws1', 'src1', { ...base, contentHash } as any)
  return { r, hash: updates.find(u => 'contentHash' in u)?.contentHash as string | undefined }
}

beforeEach(() => {
  vi.clearAllMocks()
  listChunksBySource.mockResolvedValue([chunk])
})

describe('`C-434` 同步 → 商品清單', () => {
  it('② ⛔ 沒有開關欄的表：指紋跟改版前的算法一個字都不差', async () => {
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(card()))
    const { hash } = await syncOnce('')
    const legacy = createHash('sha256').update(`Giaretti\u0000${CONTENT}`).digest('hex')
    expect(hash).toBe(legacy)
  })

  it('① 只改勾勾：算「變了」（不是 unchanged）；再同步一次同樣的勾＝unchanged', async () => {
    readGoogleSheetAsCards.mockResolvedValue(sheetOf(card({ 放進LINE目錄: 'FALSE' }), ['放進LINE目錄']))
    const first = await syncOnce('')
    expect(first.hash).toBeTruthy()

    readGoogleSheetAsCards.mockResolvedValue(sheetOf(card({ 放進LINE目錄: 'TRUE' }), ['放進LINE目錄']))
    const toggled = await syncOnce(first.hash!)
    expect(toggled.r.outcome).toBe('synced')
    // 卡片內文沒變：知識卡一條都不動（不重補問法、不重做總覽）
    expect(toggled.r).toMatchObject({ added: 0, updated: 0, deleted: 0 })
    expect(toggled.hash).not.toBe(first.hash)

    const same = await syncOnce(toggled.hash!)
    expect(same.r.outcome).toBe('unchanged')
  })

  it('③ 表變了、表沒變，都把讀到的表交給商品清單（含開關欄）', async () => {
    const sheet = sheetOf(card({ 放進LINE目錄: 'TRUE' }), ['放進LINE目錄'])
    readGoogleSheetAsCards.mockResolvedValue(sheet)
    const { hash } = await syncOnce('')
    expect(syncSheetProducts).toHaveBeenCalledTimes(1)
    expect(syncSheetProducts).toHaveBeenLastCalledWith(expect.anything(), 'ws1', 'src1', sheet)

    const again = await syncOnce(hash!)
    expect(again.r.outcome).toBe('unchanged')
    expect(syncSheetProducts).toHaveBeenCalledTimes(2)
  })

  it('對照組：大量刪除被擋下＝什麼都不套用，商品清單也不動', async () => {
    readGoogleSheetAsCards.mockResolvedValue({ cards: [], fieldHeaders: HEADERS, controlHeaders: [], stats: {} })
    listChunksBySource.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ ...chunk, id: `c${i}`, title: `T${i}` })))
    const { r } = await syncOnce('')
    expect(r.outcome).toBe('blocked_mass_deletion')
    expect(syncSheetProducts).not.toHaveBeenCalled()
  })
})
