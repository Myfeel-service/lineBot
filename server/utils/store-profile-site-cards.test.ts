/**
 * 開帳讀到的頁 → 「等你看過」的卡（`C-250`③，`store-profile-jobs.ts` 的 advanceSiteCards）。
 *
 * 守的是四件「做錯了不會有任何人發現」的事：
 *   ① 卡一律是 draft（⛔ 沒點頭就上線）
 *   ② 封頂 50 張、一頁 15 張，**超過的張數照實記**（過濾掉東西要說得出丟了什麼）
 *   ③ 兩邊同時推（精靈＋知識庫頁＋排程）不會同一頁切兩次（租約）
 *   ④ 維運額度擋下＝停在原地等，⛔ 不算失敗、不前進（下個月還推得動）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
  Timestamp: { fromMillis: (ms: number) => ({ __ts: ms, toMillis: () => ms }), now: () => ({ __ts: Date.now() }) },
}))
vi.mock('./firebase', () => ({ getDb: () => { throw new Error('test 必須自帶 db') } }))
const { chunkSegment, createKnowledgeChunk, assertMaintenanceBudget, recordAiUsage } = vi.hoisted(() => ({
  chunkSegment: vi.fn(),
  createKnowledgeChunk: vi.fn(async () => ({ id: 'x', status: 'draft', embeddingTokens: 3 })),
  assertMaintenanceBudget: vi.fn(async () => {}),
  recordAiUsage: vi.fn(async () => {}),
}))
vi.mock('./ai-knowledge-chunker', () => ({ chunkSegment, SEGMENT_CHAR_LEN: 8000 }))
vi.mock('./ai-knowledge-chunks', () => ({ createKnowledgeChunk }))
vi.mock('./ai-knowledge-sources', () => ({ KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources' }))
vi.mock('./ai-knowledge-quota', () => ({ invalidateKnowledgeChunkCount: vi.fn() }))
vi.mock('./ai-usage', () => ({ assertMaintenanceBudget, recordAiUsage }))
vi.mock('./gemini', () => ({ runWithLlmBudget: (_w: string, fn: () => unknown) => fn() }))
vi.mock('./store-profile-extract', () => ({}))
vi.mock('./store-profile', () => ({}))

import { advanceSiteCards, sitePageLabel, SITE_CARDS_MAX_PER_PAGE, SITE_CARDS_MAX_TOTAL } from './store-profile-jobs'

/** 假 Firestore：storeProfileJobs／knowledgeSources 兩個 collection；update 認得 `cards.status` 這種點號路徑 */
function makeDb(job: Record<string, any>) {
  const store: Record<string, Record<string, any>> = { storeProfileJobs: { j1: structuredClone(job) }, knowledgeSources: {} }
  const applyDotted = (obj: Record<string, any>, patch: Record<string, any>) => {
    for (const [k, v] of Object.entries(patch)) {
      const parts = k.split('.')
      let cur = obj
      for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {})
      cur[parts.at(-1)!] = v
    }
  }
  const ref = (col: string, id: string) => ({
    get: async () => ({ exists: store[col]![id] != null, data: () => store[col]![id] }),
    set: async (p: Record<string, any>, opts?: { merge?: boolean }) => {
      store[col]![id] = opts?.merge ? { ...store[col]![id], ...p } : { ...p }
    },
    update: async (p: Record<string, any>) => applyDotted(store[col]![id]!, p),
  })
  const db: any = {
    collection: (col: string) => ({ doc: (id: string) => ref(col, id) }),
    runTransaction: async (fn: (tx: any) => unknown) => fn({
      get: (r: any) => r.get(),
      update: (r: any, p: Record<string, any>) => r.update(p),
    }),
  }
  return { db, store }
}

const page = (n: number) => ({ url: `https://shop.example.tw/p${n}`, text: `第 ${n} 頁的內容` })
const cardsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `卡${i}`, content: '內容', tags: [], questions: [] }))
const baseJob = (pages: number, cards: Record<string, any> = {}) => ({
  workspaceId: 'ws1',
  pages: Array.from({ length: pages }, (_, i) => page(i + 1)),
  cards: { status: 'queued', pagesDone: 0, pagesTotal: pages, cards: 0, trimmed: 0, pagesFailed: [], ...cards },
})

beforeEach(() => {
  vi.clearAllMocks()
  chunkSegment.mockResolvedValue({ chunks: cardsOf(3), inputTokens: 100, outputTokens: 50 })
})

describe('一步整理最多 2 頁，卡一律是等你看過', () => {
  it('第一步整理前兩頁：一頁一份資料、卡都是 draft、花的錢入帳', async () => {
    const { db, store } = makeDb(baseJob(5))
    const s = await advanceSiteCards('j1', db)
    expect(s!.pagesDone).toBe(2)
    expect(s!.cards).toBe(6)
    expect(s!.status).toBe('queued')
    expect(createKnowledgeChunk).toHaveBeenCalledTimes(6)
    for (const call of createKnowledgeChunk.mock.calls) expect((call as any[])[1].draft).toBe(true)
    const sources = Object.values(store.knowledgeSources!)
    expect(sources).toHaveLength(2)
    expect(sources[0]!.origin).toBe('onboarding-site')
    // ⛔ 不排自動同步（他還沒點頭，偵測到變動會去問他一件他還沒答應要的事）
    expect(sources[0]!.refreshIntervalMinutes).toBe(0)
    expect(recordAiUsage).toHaveBeenCalledWith('ws1', expect.objectContaining({ importInputTokens: 200, importOutputTokens: 100 }), db)
    expect(store.storeProfileJobs!.j1!.cards.leaseUntil).toBe(0)
  })

  it('走完最後一頁才算 done', async () => {
    const { db } = makeDb(baseJob(3, { pagesDone: 2, cards: 6 }))
    expect((await advanceSiteCards('j1', db))!.status).toBe('done')
  })
})

describe('⛔ 封頂而且講得出丟了幾張', () => {
  it(`一頁最多 ${SITE_CARDS_MAX_PER_PAGE} 張；全部最多 ${SITE_CARDS_MAX_TOTAL} 張，超過的記進 trimmed`, async () => {
    chunkSegment.mockResolvedValue({ chunks: cardsOf(40), inputTokens: 1, outputTokens: 1 })
    const { db } = makeDb(baseJob(5, { pagesDone: 2, cards: SITE_CARDS_MAX_TOTAL - 20 }))
    const s = await advanceSiteCards('j1', db)
    // 第一頁 15（被一頁上限切掉 25）、第二頁只剩 5 的空間（切掉 35）
    expect(s!.cards).toBe(SITE_CARDS_MAX_TOTAL)
    expect(s!.trimmed).toBe((40 - 15) + (40 - 5))
  })

  it('整理失敗的頁照實記原因，其他頁照常', async () => {
    chunkSegment.mockRejectedValueOnce(new Error('JSON 被截斷'))
    const { db } = makeDb(baseJob(2))
    const s = await advanceSiteCards('j1', db)
    expect(s!.pagesFailed).toHaveLength(1)
    expect(s!.pagesFailed[0]!.reason).toContain('截斷')
    expect(s!.cards).toBe(3)
    expect(s!.status).toBe('done')
  })
})

describe('同時推、額度擋下', () => {
  it('⛔ 別人正拿著租約：不整理、原樣回（同一頁切兩次＝收兩次錢）', async () => {
    const { db } = makeDb(baseJob(5, { leaseUntil: Date.now() + 60_000 }))
    const s = await advanceSiteCards('j1', db)
    expect(chunkSegment).not.toHaveBeenCalled()
    expect(s!.pagesDone).toBe(0)
  })

  it('⛔ 維運額度擋下（429）：停在原地、不算失敗、講得出為什麼', async () => {
    assertMaintenanceBudget.mockRejectedValueOnce(Object.assign(new Error('額度'), { statusCode: 429 }))
    const { db } = makeDb(baseJob(5))
    const s = await advanceSiteCards('j1', db)
    expect(s!.status).toBe('queued')
    expect(s!.pagesDone).toBe(0)
    expect(s!.pagesFailed).toHaveLength(0)
    expect(s!.error).toContain('額度')
  })

  it('整理完了就不再動', async () => {
    const { db } = makeDb(baseJob(2, { status: 'done', pagesDone: 2 }))
    await advanceSiteCards('j1', db)
    expect(chunkSegment).not.toHaveBeenCalled()
  })
})

describe('這一頁在知識庫叫什麼', () => {
  it('首頁叫首頁；網址有中文用中文；英文代號退回第一張卡的標題', () => {
    expect(sitePageLabel('https://shop.example.tw/')).toBe('首頁')
    expect(sitePageLabel('https://shop.example.tw/%E9%BB%91%E8%B1%86%E6%B0%B4')).toBe('黑豆水')
    expect(sitePageLabel('https://shop.example.tw/products/1234', '黑豆水 1000ml')).toBe('黑豆水 1000ml')
    expect(sitePageLabel('https://shop.example.tw/about-us.html')).toBe('about us')
  })
})
