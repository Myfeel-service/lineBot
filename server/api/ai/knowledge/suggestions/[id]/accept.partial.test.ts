/**
 * 「採用並學習」只採用其中幾題（`C-311`，2026-10-14 老闆拍板）。
 *
 * 正式站實例：「小滑手」那組四題是同一個產品的不同問題（哪一國做的／只能沖義式嗎／能邊萃取邊打奶泡嗎／寬深高），
 * 寫一條回答其中一題、按採用，以前整組標成已處理，其他三題沒人回答就從清單消失。這裡釘住：
 *  ① 只勾一題：沒勾的留在同一筆、照舊待處理，次數照實、草稿清掉等重擬、名字退回客人原句；只銷勾的那題的對話、拿勾的那題試答
 *  ② 什麼都沒丟：建卡那幾秒內掃描剛好更新了這一筆（多了新的問句），也不會被佔位前的舊快照蓋掉
 *  ③ 整組採用照舊：沒帶勾選（舊版畫面）或全勾＝accepted，跟改版前一樣
 *  ④ 守門照舊：一題都沒勾 400、勾的都已經處理過 409（不建卡）、額度照樣先檢查
 *  ⑤ 稽核寫明回答了幾題、還有幾題留在清單
 * 跑在記憶體裡的假 Firestore 上，建卡／試答／稽核都是假的，正式庫零讀零寫、不連網。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const DELETE = Symbol('FieldValue.delete')
  return {
    DELETE,
    FieldValue: {
      serverTimestamp: () => '__ts__',
      delete: () => DELETE,
      vector: (arr: number[]) => ({ toArray: () => [...arr] }),
    },
    Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
  }
})
vi.mock('firebase-admin/firestore', () => ({ FieldValue: h.FieldValue, Timestamp: h.Timestamp }))

const WS = 'ws1'
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/gemini', () => ({
  embedQuery: vi.fn(),
  embedDocument: vi.fn(),
  generateJson: vi.fn(),
  estimateTokens: (t: string) => Math.ceil(t.length / 4),
  runWithLlmBudget: vi.fn(),
}))
vi.mock('~~/server/utils/ai-usage', () => ({ recordAiUsage: vi.fn(), AI_USAGE_COLLECTION: 'aiUsage', currentYyyyMm: () => '2026-10' }))
vi.mock('~~/server/utils/ai-handoff-notify', () => ({ notifyKnowledgeSourceEvent: vi.fn() }))
vi.mock('~~/server/utils/ai-knowledge-sources', () => ({ KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources' }))
vi.mock('~~/server/utils/ai-knowledge-quota', () => ({
  assertKnowledgeChunkQuota: vi.fn(async () => {}),
  invalidateKnowledgeChunkCount: vi.fn(),
}))
vi.mock('~~/server/utils/ai-knowledge-chunks', async (importActual) => {
  const actual = await importActual<typeof import('~~/server/utils/ai-knowledge-chunks')>()
  return {
    // 內容檢查用真的（問法切 3 條、空標題擋下），建卡是假的
    normalizeChunkInput: actual.normalizeChunkInput,
    validateChunkInput: actual.validateChunkInput,
    KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
    createKnowledgeChunk: vi.fn(async (_db: unknown, p: { chunkId: string }) => ({ id: p.chunkId, status: 'indexed', embeddingTokens: 0 })),
  }
})
vi.mock('~~/server/utils/ai-knowledge-suggest', async (importActual) => ({
  ...(await importActual<typeof import('~~/server/utils/ai-knowledge-suggest')>()),
  resolveHandoffsByQueries: vi.fn(async (_db: unknown, _ws: string, qs: string[]) => qs.length),
}))
vi.mock('~~/server/utils/ai-answer', () => ({
  answerWithAi: vi.fn(async () => ({ decision: 'answered', confidence: 0.9 })),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

// ── 記憶體 Firestore（只做採用會用到的；交易的寫入等 fn 跑完才套用）─────
type Doc = Record<string, any>
const STORE: Record<string, Record<string, Doc>> = {}
function apply(col: string, id: string, patch: Doc, merge: boolean) {
  const cur: Doc = merge ? { ...(STORE[col]?.[id] ?? {}) } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === h.DELETE) delete cur[k]
    else cur[k] = v
  }
  ;(STORE[col] ??= {})[id] = cur
}
const snap = (col: string, id: string) => ({ id, exists: !!STORE[col]?.[id], data: () => (STORE[col]?.[id] ? { ...STORE[col]![id] } : undefined) })
const ref = (col: string, id: string): any => ({
  id,
  __col: col,
  get: async () => snap(col, id),
  set: async (patch: Doc, opts?: { merge?: boolean }) => apply(col, id, patch, !!opts?.merge),
})
const db: any = {
  collection: (col: string) => ({ doc: (id: string) => ref(col, id) }),
  runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
    const ops: Array<() => void> = []
    const out = await fn({
      get: async (r: any) => snap(r.__col, r.id),
      update: (r: any, patch: Doc) => { ops.push(() => apply(r.__col, r.id, patch, true)) },
      set: (r: any, patch: Doc, opts?: { merge?: boolean }) => { ops.push(() => apply(r.__col, r.id, patch, !!opts?.merge)) },
    })
    for (const op of ops) op()
    return out
  },
}
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 's1')
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { createKnowledgeChunk } = await import('~~/server/utils/ai-knowledge-chunks')
const { assertKnowledgeChunkQuota } = await import('~~/server/utils/ai-knowledge-quota')
const { resolveHandoffsByQueries } = await import('~~/server/utils/ai-knowledge-suggest')
const { answerWithAi } = await import('~~/server/utils/ai-answer')
const { writeAuditLog } = await import('~~/server/utils/audit-log')
const { default: handler } = await import('./accept.post')

const call = () => (handler as unknown as (e: unknown) => Promise<any>)({}).catch((e: any) => e)

const ORIGIN = '請問一下小滑手咖啡機是哪一國做的？'
const ESPRESSO = '小滑手只能沖義式咖啡嗎？'
const FROTH = '小滑手咖啡機 能萃取咖啡液的同時打奶泡嗎'
const SIZE = '小滑手咖啡機 寬/深/高各多少'
const GROUP = [ORIGIN, ESPRESSO, FROTH, SIZE]
const DRAFT = { title: '小滑手咖啡機的產地', content: '【請填寫：產地】', tags: ['小滑手'], questions: ['小滑手哪裡製造'] }

const card = { title: '小滑手咖啡機的產地', content: '小滑手咖啡機是台灣設計、台灣製造。', tags: [], questions: ['小滑手哪裡製造', ORIGIN] }
const s1 = () => STORE.knowledgeSuggestions!.s1!
const auditNote = () => String((vi.mocked(writeAuditLog).mock.calls[0]![0] as { note?: string }).note)

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
  STORE.knowledgeSuggestions = {
    s1: {
      workspaceId: WS,
      status: 'pending',
      topic: '小滑手咖啡機',
      topicIsRaw: false,
      queries: GROUP,
      queryCounts: [3, 2, 1, 1],
      sampleQueries: GROUP,
      eventCount: 7,
      sampled: false,
      centroid: h.FieldValue.vector([1, 0]),
      draft: DRAFT,
      blanksCount: 1,
      draftError: '舊的失敗原因',
    },
  }
})

describe('只採用其中幾題（C-311）', () => {
  it('① 只勾一題：建一條、沒勾的三題留在同一筆待處理，次數照實、草稿清掉、名字退回客人原句', async () => {
    body = { ...card, answeredQueries: [ORIGIN] }
    const res = await call()

    expect(res).toMatchObject({ status: 'indexed', remainingQuestions: 3 })
    expect(createKnowledgeChunk).toHaveBeenCalledTimes(1)
    // 建出來的那一條：問法就是畫面上送來的（勾的那題已經在裡面）
    expect(vi.mocked(createKnowledgeChunk).mock.calls[0]![1]).toMatchObject({ questions: ['小滑手哪裡製造', ORIGIN] })

    expect(s1()).toMatchObject({
      status: 'pending',
      queries: [ESPRESSO, FROTH, SIZE],
      queryCounts: [2, 1, 1],
      sampleQueries: [ESPRESSO, FROTH, SIZE],
      eventCount: 4,
      sampled: false,
      answeredQueries: [ORIGIN],
      draft: null,
      blanksCount: 0,
      topic: ESPRESSO.slice(0, 12),
      topicIsRaw: true,
    })
    expect(s1()).not.toHaveProperty('draftError')
    expect(s1()).not.toHaveProperty('acceptedChunkId')
    expect(s1()).not.toHaveProperty('expireAt') // ⛔ 還待處理的不能被 TTL 清掉

    // 只銷勾的那題的對話、拿勾的那題試答
    expect(vi.mocked(resolveHandoffsByQueries).mock.calls[0]![2]).toEqual([ORIGIN])
    expect(vi.mocked(answerWithAi).mock.calls[0]![0]).toMatchObject({ query: ORIGIN, isTest: true })
  })

  it('① 勾的不是代表句：試答拿勾的那題，不拿清單第一題（那題沒回答）', async () => {
    body = { ...card, answeredQueries: [SIZE, FROTH] }
    const res = await call()

    expect(res.remainingQuestions).toBe(2)
    expect(s1()).toMatchObject({ queries: [ORIGIN, ESPRESSO], eventCount: 5, answeredQueries: [FROTH, SIZE] })
    // 照組內順序：FROTH 在 SIZE 前面
    expect(vi.mocked(answerWithAi).mock.calls[0]![0]).toMatchObject({ query: FROTH })
  })

  it('② 建卡那幾秒內掃描更新了這一筆（多了一題）→ 新的那題也留著，不被舊快照蓋掉', async () => {
    const NEW = '小滑手有保固嗎'
    vi.mocked(createKnowledgeChunk).mockImplementationOnce(async (_db: unknown, p: any) => {
      // 模擬掃描在這時寫回（狀態還是 accepting，掃描不動狀態）
      apply('knowledgeSuggestions', 's1', { queries: [...GROUP, NEW], queryCounts: [3, 2, 1, 1, 2], eventCount: 9 }, true)
      return { id: p.chunkId, status: 'indexed', embeddingTokens: 0 }
    })
    body = { ...card, answeredQueries: [ORIGIN] }
    const res = await call()

    expect(res.remainingQuestions).toBe(4)
    expect(s1()).toMatchObject({ status: 'pending', queries: [ESPRESSO, FROTH, SIZE, NEW], queryCounts: [2, 1, 1, 2], eventCount: 6 })
  })

  it('③ 舊版畫面（沒帶勾選）＝整組採用，跟改版前一樣', async () => {
    body = { ...card }
    const res = await call()

    expect(res.remainingQuestions).toBe(0)
    expect(s1()).toMatchObject({ status: 'accepted', acceptedChunkId: res.chunkId, acceptedSourceId: res.sourceId })
    expect(s1()).toHaveProperty('expireAt')
    expect(s1().queries).toEqual(GROUP) // 整組採用不動題目
    expect(vi.mocked(resolveHandoffsByQueries).mock.calls[0]![2]).toEqual(GROUP)
    expect(vi.mocked(answerWithAi).mock.calls[0]![0]).toMatchObject({ query: ORIGIN })
  })

  it('③ 全勾＝整組採用', async () => {
    body = { ...card, answeredQueries: [...GROUP] }
    const res = await call()

    expect(res.remainingQuestions).toBe(0)
    expect(s1().status).toBe('accepted')
  })

  it('④ 一題都沒勾 → 400，額度不查、建議不動、不建卡', async () => {
    body = { ...card, answeredQueries: [] }
    await expect(call()).resolves.toMatchObject({ statusCode: 400 })
    expect(assertKnowledgeChunkQuota).not.toHaveBeenCalled()
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
    expect(s1().status).toBe('pending')
  })

  it('④ 勾的都已經不在這一組（另一個分頁先回答掉了）→ 409，不建出重複的一條、建議不動', async () => {
    STORE.knowledgeSuggestions!.s1!.queries = [ESPRESSO, FROTH, SIZE]
    STORE.knowledgeSuggestions!.s1!.answeredQueries = [ORIGIN]
    body = { ...card, answeredQueries: [ORIGIN] }
    await expect(call()).resolves.toMatchObject({ statusCode: 409 })
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
    expect(s1().status).toBe('pending')
  })

  it('④ 額度照樣在佔位之前檢查（一條）', async () => {
    body = { ...card, answeredQueries: [ORIGIN] }
    await call()
    expect(vi.mocked(assertKnowledgeChunkQuota).mock.calls[0]![1]).toBe(1)
  })

  it('⑤ 稽核寫明回答了幾題、還有幾題留在清單', async () => {
    body = { ...card, answeredQueries: [ORIGIN] }
    await call()
    expect(auditNote()).toContain('回答了 1 題，還有 3 題留在清單上')
    expect(vi.mocked(writeAuditLog).mock.calls[0]![0]).toMatchObject({
      action: 'knowledge.suggestionAccept',
      after: { answeredQuestions: 1, remainingQuestions: 3 },
    })
  })

  it('⑤ 整組採用的稽核：回答了全部幾題、不提留在清單', async () => {
    body = { ...card }
    await call()
    expect(auditNote()).toContain('回答了 4 題）')
    expect(auditNote()).not.toContain('留在清單')
  })
})

describe('「寫一句答案」建出來的那一份（C-318）', () => {
  it('帶 isDeleted:false＋未分類：資料清單的主查詢（isDeleted == false）才撈得到，不會資料一多就從左邊消失', async () => {
    body = { title: '小滑手的產地', content: '中國製造。', tags: [], questions: [ORIGIN], answeredQueries: [ORIGIN] }
    const res = await call()
    expect(STORE.knowledgeSources![res.sourceId]).toMatchObject({
      workspaceId: WS,
      type: 'manual',
      name: '小滑手的產地',
      isDeleted: false,
      folderId: null,
      status: 'ready',
    })
  })

  it('沒按「AI 幫我整理」也收（標題＝客人問的那句、內容＝一兩句、沒有標籤）', async () => {
    body = { title: ORIGIN, content: '中國製造。', tags: [], questions: [ORIGIN] }
    const res = await call()
    expect(res.status).toBe('indexed')
    expect(vi.mocked(createKnowledgeChunk).mock.calls[0]![1]).toMatchObject({ title: ORIGIN, content: '中國製造。', tags: [], questions: [ORIGIN] })
  })
})
