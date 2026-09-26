/**
 * 開帳讀到的頁 → 「等你看過」的卡（`C-250`③，`store-profile-jobs.ts` 的 advanceSiteCards）。
 *
 * 守的是「做錯了不會有任何人發現」的事：
 *   ① 卡一律是 draft（⛔ 沒點頭就上線）
 *   ② 封頂 50 張、一頁 15 張，**超過的張數照實記**（過濾掉東西要說得出丟了什麼）
 *   ③ 兩邊同時推不會同一頁切兩次（租約）；🔴 租約被接手之後，原本那一次**不可以蓋掉**接手那一次的進度
 *   ④ 維運額度擋下＝停在原地等，⛔ 不算失敗、不前進；錯誤訊息下一次成功要清掉；工作要留到下個月
 *   ⑤ 🔴 建到一半被砍：下一步從切好的那一份接著建，⛔ 不再切一次、⛔ 不會多一張（id 固定）
 *   ⑥ 一時的模型錯誤先重試，滿 3 次才記成「整理不出卡」
 *   ⑦ 重跑讀網站：同一頁之前整理過就跳過（照實記幾頁）
 * （⑤～⑦ 是 2026-09-26 code review 抓到之後補的）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
  Timestamp: { fromMillis: (ms: number) => ({ __ts: ms, toMillis: () => ms }), now: () => ({ __ts: Date.now() }) },
}))
vi.mock('./firebase', () => ({ getDb: () => { throw new Error('test 必須自帶 db') } }))
const h = vi.hoisted(() => ({
  store: {} as Record<string, Record<string, Record<string, any>>>,
  chunkSegment: vi.fn(),
  assertMaintenanceBudget: vi.fn(async () => {}),
  recordAiUsage: vi.fn(async () => {}),
}))
const createKnowledgeChunk = vi.hoisted(() => vi.fn(async (_db: unknown, p: { chunkId: string }) => {
  h.store.knowledgeChunks![p.chunkId] = { ...p, status: 'draft' }
  return { id: p.chunkId, status: 'draft', embeddingTokens: 3 }
}))
vi.mock('./ai-knowledge-chunker', () => ({ chunkSegment: h.chunkSegment, SEGMENT_CHAR_LEN: 8000 }))
vi.mock('./ai-knowledge-chunks', () => ({ createKnowledgeChunk, KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('./ai-knowledge-sources', () => ({ KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources' }))
vi.mock('./ai-knowledge-quota', () => ({ invalidateKnowledgeChunkCount: vi.fn() }))
vi.mock('./ai-usage', () => ({ assertMaintenanceBudget: h.assertMaintenanceBudget, recordAiUsage: h.recordAiUsage }))
vi.mock('./gemini', () => ({ runWithLlmBudget: (_w: string, fn: () => unknown) => fn() }))
vi.mock('./store-profile-extract', () => ({}))
vi.mock('./store-profile', () => ({}))

import {
  advanceSiteCards,
  siteCardsSourceId,
  sitePageLabel,
  SITE_CARDS_MAX_PER_PAGE,
  SITE_CARDS_MAX_TOTAL,
  SITE_CARDS_PAGE_MAX_TRIES,
  supersedeSiteCardsJob,
} from './store-profile-jobs'

const { chunkSegment, assertMaintenanceBudget, recordAiUsage } = h

/** 假 Firestore：update 認得 `cards.status` 這種點號路徑、也認得整格 `cards` 蓋掉；where 只做等值 */
function makeDb(job: Record<string, any>, extra: Record<string, Record<string, any>> = {}) {
  h.store = { storeProfileJobs: { j1: structuredClone(job) }, knowledgeSources: {}, knowledgeChunks: {}, storeProfiles: {}, ...structuredClone(extra) }
  const store = h.store
  const applyDotted = (obj: Record<string, any>, patch: Record<string, any>) => {
    for (const [k, v] of Object.entries(patch)) {
      const parts = k.split('.')
      let cur = obj
      for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {})
      // 深拷貝＝跟真的 Firestore 一樣，寫進去之後呼叫端再改那個物件也不會跟著變（假 Timestamp 帶函式，拷不了就照放）
      let copy = v
      try { copy = structuredClone(v) }
      catch { /* 帶函式的物件 */ }
      cur[parts.at(-1)!] = copy
    }
  }
  const ref = (col: string, id: string) => ({
    get: async () => ({ exists: store[col]![id] != null, data: () => store[col]![id] }),
    set: async (p: Record<string, any>, opts?: { merge?: boolean }) => {
      store[col]![id] = opts?.merge ? { ...store[col]![id], ...p } : { ...p }
    },
    update: async (p: Record<string, any>) => applyDotted(store[col]![id]!, p),
  })
  const query = (col: string, filters: [string, unknown][] = []) => ({
    where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]]),
    limit: () => query(col, filters),
    get: async () => ({
      docs: Object.entries(store[col] ?? {})
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => ({ id, data: () => d })),
    }),
  })
  const db: any = {
    collection: (col: string) => ({ doc: (id: string) => ref(col, id), where: (f: string, op: string, v: unknown) => query(col).where(f, op, v) }),
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

describe('一步：切一頁、建成等你看過的卡', () => {
  it('卡都是 draft、一頁一份資料（id 固定）、花的錢入帳、租約放掉', async () => {
    const { db, store } = makeDb(baseJob(5))
    const s = await advanceSiteCards('j1', db, { budgetMs: 60_000 })
    // 預算夠就一路做完
    expect(s!.pagesDone).toBe(5)
    expect(s!.cards).toBe(15)
    expect(s!.status).toBe('done')
    for (const call of createKnowledgeChunk.mock.calls) expect((call as any[])[1].draft).toBe(true)
    const src = store.knowledgeSources![siteCardsSourceId('j1', 0)]!
    expect(src.origin).toBe('onboarding-site')
    // ⛔ 不排自動同步（他還沒點頭，偵測到變動會去問他一件他還沒答應要的事）
    expect(src.refreshIntervalMinutes).toBe(0)
    expect(Object.keys(store.knowledgeChunks!)).toContain(`${siteCardsSourceId('j1', 0)}_2`)
    expect(recordAiUsage).toHaveBeenCalledWith('ws1', expect.objectContaining({ importInputTokens: 500, importOutputTokens: 250 }), db)
    expect(store.storeProfileJobs!.j1!.cards.leaseUntil).toBe(0)
    expect(store.storeProfileJobs!.j1!.cards.pending).toBeNull()
  })

  it('預算用完就停、下一步接著做（⛔ 不一口氣做到逾時）', async () => {
    const { db } = makeDb(baseJob(5))
    const s = await advanceSiteCards('j1', db, { budgetMs: 0 })
    expect(chunkSegment).not.toHaveBeenCalled()
    expect(s!.status).toBe('queued')
  })
})

describe('🔴 建到一半被砍：接著建，⛔ 不再切一次、不會多一張', () => {
  it('切好的先寫回；下一步從 pending.next 接著建', async () => {
    const pending = { page: 0, sourceId: siteCardsSourceId('j1', 0), chunks: cardsOf(3), next: 1 }
    // 第 0 張上一次已經建好（下一次不可以再寫它：他可能已經點頭採用了）
    const { db, store } = makeDb(baseJob(1, { pending, cards: 1 }), {
      knowledgeChunks: { [`${pending.sourceId}_0`]: { status: 'indexed' } },
    })
    const s = await advanceSiteCards('j1', db, { budgetMs: 60_000 })
    expect(chunkSegment).not.toHaveBeenCalled()
    expect(createKnowledgeChunk.mock.calls.map(c => (c as any[])[1].chunkId)).toEqual([`${pending.sourceId}_1`, `${pending.sourceId}_2`])
    expect(store.knowledgeChunks![`${pending.sourceId}_0`]!.status).toBe('indexed')
    expect(s!.cards).toBe(3)
    expect(s!.status).toBe('done')
  })

  it('重做同一頁（例如中途被砍在寫回之前）：已經在的卡跳過、張數照算，⛔ 不會多一張', async () => {
    const sid = siteCardsSourceId('j1', 0)
    const { db, store } = makeDb(baseJob(1), {
      knowledgeChunks: { [`${sid}_0`]: { status: 'draft' }, [`${sid}_1`]: { status: 'draft' } },
      knowledgeSources: { [sid]: { workspaceId: 'ws1', origin: 'onboarding-site', url: page(1).url } },
    })
    const s = await advanceSiteCards('j1', db, { budgetMs: 60_000 })
    expect(createKnowledgeChunk).toHaveBeenCalledTimes(1)
    expect(Object.keys(store.knowledgeChunks!).filter(k => k.startsWith(sid))).toHaveLength(3)
    expect(s!.cards).toBe(3)
  })
})

describe('⛔ 封頂而且講得出丟了幾張', () => {
  it(`一頁最多 ${SITE_CARDS_MAX_PER_PAGE} 張；全部最多 ${SITE_CARDS_MAX_TOTAL} 張，超過的記進 trimmed`, async () => {
    chunkSegment.mockResolvedValue({ chunks: cardsOf(40), inputTokens: 1, outputTokens: 1 })
    const { db } = makeDb(baseJob(4, { pagesDone: 2, cards: SITE_CARDS_MAX_TOTAL - 20 }))
    const s = await advanceSiteCards('j1', db, { budgetMs: 60_000 })
    // 第 3 頁 15（被一頁上限切掉 25）、第 4 頁只剩 5 的空間（切掉 35）
    expect(s!.cards).toBe(SITE_CARDS_MAX_TOTAL)
    expect(s!.trimmed).toBe((40 - 15) + (40 - 5))
  })
})

describe('一時的錯誤先重試', () => {
  it(`失敗一次：不前進、不記失敗；第 ${SITE_CARDS_PAGE_MAX_TRIES} 次才記成整理不出卡`, async () => {
    chunkSegment.mockRejectedValue(Object.assign(new Error('Gemini 503 過載'), { statusCode: 503 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db } = makeDb(baseJob(2))
    let s = await advanceSiteCards('j1', db, { budgetMs: 60_000 })
    expect(s!.pagesDone).toBe(0)
    expect(s!.pagesFailed).toHaveLength(0)
    expect(s!.tries).toBe(1)
    s = await advanceSiteCards('j1', db, { budgetMs: 60_000 })
    expect(s!.pagesFailed).toHaveLength(0)
    chunkSegment.mockRejectedValueOnce(new Error('JSON 被截斷')).mockResolvedValue({ chunks: cardsOf(2), inputTokens: 1, outputTokens: 1 })
    s = await advanceSiteCards('j1', db, { budgetMs: 60_000 })
    // 第 3 次還是失敗 → 記原因、往下一頁；下一頁照常
    expect(s!.pagesFailed).toEqual([{ url: page(1).url, reason: expect.stringContaining('截斷') }])
    expect(s!.cards).toBe(2)
    expect(s!.status).toBe('done')
    warn.mockRestore()
  })
})

describe('租約與額度', () => {
  it('⛔ 別人正拿著租約：不整理、原樣回', async () => {
    const { db } = makeDb(baseJob(5, { leaseUntil: Date.now() + 60_000, leaseId: 'other' }))
    const s = await advanceSiteCards('j1', db)
    expect(chunkSegment).not.toHaveBeenCalled()
    expect(s!.pagesDone).toBe(0)
  })

  it('🔴 做到一半租約被別人接手：原本那一次 ⛔ 不寫回（不蓋掉接手那一次的進度）', async () => {
    const { db, store } = makeDb(baseJob(1))
    chunkSegment.mockImplementationOnce(async () => {
      // 模擬：切卡太久、租約過期，別人接手了
      store.storeProfileJobs!.j1!.cards.leaseId = 'someone-else'
      store.storeProfileJobs!.j1!.cards.pagesDone = 1
      store.storeProfileJobs!.j1!.cards.status = 'done'
      return { chunks: cardsOf(3), inputTokens: 1, outputTokens: 1 }
    })
    const s = await advanceSiteCards('j1', db, { budgetMs: 60_000 })
    expect(store.storeProfileJobs!.j1!.cards.leaseId).toBe('someone-else')
    expect(store.storeProfileJobs!.j1!.cards.status).toBe('done')
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
    expect(s!.status).toBe('done')
  })

  it('⛔ 維運額度擋下：停在原地、不算失敗、講得出還剩幾頁、工作留到下個月', async () => {
    assertMaintenanceBudget.mockRejectedValueOnce(Object.assign(new Error('本月 AI 整理用量已達安全上限'), { statusCode: 429 }))
    const { db, store } = makeDb(baseJob(5))
    const s = await advanceSiteCards('j1', db)
    expect(s!.status).toBe('queued')
    expect(s!.pagesDone).toBe(0)
    expect(s!.pagesFailed).toHaveLength(0)
    expect(s!.error).toContain('還有 5 頁')
    expect(store.storeProfileJobs!.j1!.expiresAt.__ts).toBeGreaterThan(Date.now() + 24 * 3600_000)
    // 額度回來之後那一步成功＝錯誤訊息清掉（原本 merge 寫回，那一格永遠留著）
    const s2 = await advanceSiteCards('j1', db, { budgetMs: 60_000 })
    expect(s2!.error).toBeUndefined()
    expect(store.storeProfileJobs!.j1!.cards.error).toBeUndefined()
  })

  it('Gemini 自己的 429（一時過載）＝重試，⛔ 不是「這個月額度用完了」', async () => {
    chunkSegment.mockRejectedValueOnce(Object.assign(new Error('Gemini 429 Too Many Requests'), { statusCode: 429 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db } = makeDb(baseJob(2))
    const s = await advanceSiteCards('j1', db, { budgetMs: 60_000 })
    expect(s!.error).toBeUndefined()
    expect(s!.tries).toBe(1)
    warn.mockRestore()
  })

  it('整理完了就不再動', async () => {
    const { db } = makeDb(baseJob(2, { status: 'done', pagesDone: 2 }))
    await advanceSiteCards('j1', db)
    expect(chunkSegment).not.toHaveBeenCalled()
  })
})

describe('重跑讀網站：同一頁不建第二份', () => {
  it('同一頁之前那一份工作整理過（資料還在）＝跳過，照實記幾頁', async () => {
    const { db } = makeDb(baseJob(2), {
      knowledgeSources: { 'onb_old_0': { workspaceId: 'ws1', origin: 'onboarding-site', url: page(1).url, isDeleted: false } },
    })
    const s = await advanceSiteCards('j1', db, { budgetMs: 60_000 })
    expect(chunkSegment).toHaveBeenCalledTimes(1)
    expect(s!.skippedExisting).toBe(1)
    expect(s!.cards).toBe(3)
  })

  it('新的一份接手：上一份還沒整理完的停掉（標 superseded）', async () => {
    const { db, store } = makeDb(baseJob(3, { pagesDone: 1 }), { storeProfiles: { ws1: { siteCardsJobId: 'j1' } } })
    await supersedeSiteCardsJob('ws1', 'j2', db)
    expect(store.storeProfileJobs!.j1!.cards.status).toBe('done')
    expect(store.storeProfileJobs!.j1!.cards.superseded).toBe(true)
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
