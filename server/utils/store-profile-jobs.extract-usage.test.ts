/**
 * 開帳「讀網站認識你的店」最後一步的記帳（`C-338`①）。
 *
 * 以前 `advanceStoreProfileJob` 只取 `guesses`，模型那一次（一次最多 2.4 萬字）的 token 整筆沒記。
 * 現在記進「整理知識庫」那桶（跟同一份工作接著整理卡、換個說法同一桶），帶著實際模型；
 * 模型回的 JSON 壞掉、這一步算失敗時，錢一樣付了、一樣記。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reportAiCall } from './ai-usage-calls'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
  Timestamp: { fromMillis: (ms: number) => ({ __ts: ms, toMillis: () => ms }), now: () => ({ __ts: Date.now() }) },
}))
vi.mock('./firebase', () => ({ getDb: () => { throw new Error('test 必須自帶 db') } }))
const h = vi.hoisted(() => ({
  extract: vi.fn(),
  recordAiUsage: vi.fn(async () => {}),
}))
vi.mock('./store-profile-extract', () => ({
  extractProfileFromPages: h.extract,
  classifyFetchError: () => 'unknown',
  fetchOneProfilePage: vi.fn(),
  MAX_PROFILE_PAGES: 5,
  rankProfilePages: vi.fn(),
}))
vi.mock('./store-profile', () => ({
  getStoreProfile: vi.fn(async () => ({ fields: {} })),
  saveStoreProfile: vi.fn(async () => {}),
}))
vi.mock('~~/shared/types/store-profile', async importOriginal => ({
  ...(await importOriginal<typeof import('~~/shared/types/store-profile')>()),
  mergeAiGuesses: (profile: unknown) => ({ profile: { ...(profile as object) }, filled: [], skippedOwnerEdited: [] }),
}))
vi.mock('./ai-knowledge-chunker', () => ({ chunkSegment: vi.fn(), SEGMENT_CHAR_LEN: 8000 }))
vi.mock('./ai-knowledge-chunks', () => ({ createKnowledgeChunk: vi.fn(), KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('./ai-knowledge-quota', () => ({ invalidateKnowledgeChunkCount: vi.fn() }))
vi.mock('./ai-usage', () => ({ assertMaintenanceBudget: vi.fn(async () => {}), recordAiUsage: h.recordAiUsage }))
vi.mock('./gemini', () => ({ runWithLlmBudget: (_w: string, fn: () => unknown) => fn() }))

const { advanceStoreProfileJob } = await import('./store-profile-jobs')

function makeDb() {
  const store: Record<string, Record<string, any>> = { storeProfileJobs: {}, storeProfiles: {} }
  const ref = (col: string, id: string) => ({
    get: async () => ({ exists: store[col]?.[id] != null, data: () => store[col]?.[id] }),
    set: async (p: Record<string, any>) => { (store[col] ??= {})[id] = { ...(store[col]![id] ?? {}), ...p } },
    update: async (p: Record<string, any>) => { (store[col] ??= {})[id] = { ...(store[col]![id] ?? {}), ...p } },
  })
  const db = {
    collection: (col: string) => ({ doc: (id: string) => ref(col, id) }),
    runTransaction: async () => {},
  } as any
  return { db, store }
}

function lastStepJob() {
  return {
    workspaceId: 'ws1',
    siteUrl: 'https://shop.example',
    status: 'running',
    queue: [],
    pages: [{ url: 'https://shop.example/', text: '我們賣黑豆水與養生茶包。'.repeat(50) }],
    failed: [],
    visited: 1,
  } as any
}

const FLASH = 'gemini-2.5-flash'

beforeEach(() => {
  h.extract.mockReset()
  h.recordAiUsage.mockClear()
})

describe('讀網站認識你的店：模型那一次要記帳', () => {
  it('記進整理知識庫那桶（總數＋import*＋明細），帶著呼叫端的 db', async () => {
    h.extract.mockImplementationOnce(async () => {
      reportAiCall({ model: FLASH, inputTokens: 24_000, outputTokens: 600 })
      return { guesses: { industry: '零售' }, inputTokens: 24_000, outputTokens: 600 }
    })
    const { db } = makeDb()
    const progress = await advanceStoreProfileJob('j1', lastStepJob(), db)
    expect(progress.status).toBe('done')
    expect(h.recordAiUsage).toHaveBeenCalledWith('ws1', {
      inputTokens: 24_000,
      outputTokens: 600,
      importInputTokens: 24_000,
      importOutputTokens: 600,
      modelTokens: { build: { flash: { input: 24_000, output: 600 } } },
    }, db)
  })

  it('模型回的 JSON 壞掉＝這一步失敗，但錢一樣付了、一樣記', async () => {
    h.extract.mockImplementationOnce(async () => {
      reportAiCall({ model: FLASH, inputTokens: 24_000, outputTokens: 2048 })
      throw Object.assign(new Error('Gemini JSON parse failed'), { statusCode: 502 })
    })
    const { db } = makeDb()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const progress = await advanceStoreProfileJob('j1', lastStepJob(), db)
    err.mockRestore()
    expect(progress.status).toBe('failed')
    expect(h.recordAiUsage).toHaveBeenCalledWith('ws1', expect.objectContaining({ importInputTokens: 24_000, importOutputTokens: 2048 }), db)
  })
})
