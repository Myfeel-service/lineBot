/**
 * `C-318`：掃描怎麼對待「查他自己那一筆」的問題，以及兩種收法之後同一類再出現時怎麼辦。
 *  ① 新出現的查單那一組不建建議、不花錢擬草稿，組數記進 tally（不靜默）
 *  ② 清單上已經有的查單題目：這輪比對到就收掉（連同這輪次數）；這輪沒聚出那一組（事件滑出窗口）也照存著的題目收掉
 *  ③ 「交給真人就好」：同一類次數翻倍也不再列；「不用管」照舊翻倍才列
 *  ④ 系統收掉的查單題目，同一類現在問的是一般問題 → 放回清單
 *  ⑤ 一般問題照舊建建議（對照組：分類器沒有把所有東西都擋掉）
 * 跑在記憶體裡的假 Firestore 上（select 照實只回列出的欄位），embedding／LLM 都是假的，正式庫零讀零寫、不連網。
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
vi.mock('./gemini', () => ({
  embedQuery: vi.fn(),
  generateJson: vi.fn(),
  estimateTokens: (t: string) => Math.ceil(t.length / 4),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(), AI_USAGE_COLLECTION: 'aiUsage', currentYyyyMm: () => '2026-10' }))
vi.mock('./ai-handoff-notify', () => ({ notifyKnowledgeSourceEvent: vi.fn() }))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))

const { embedQuery, generateJson } = await import('./gemini')
const { scanWorkspaceKnowledgeGaps } = await import('./ai-knowledge-suggest')

// ── 記憶體 Firestore（同 partial-scan 那支：只做掃描會用到的；select 照實投影）──
type Doc = Record<string, any>
const STORE: Record<string, Record<string, Doc>> = {}
const millisOf = (v: any) => (typeof v?.toMillis === 'function' ? v.toMillis() : v)
function apply(col: string, id: string, patch: Doc, merge: boolean) {
  const cur: Doc = merge ? { ...(STORE[col]?.[id] ?? {}) } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === h.DELETE) delete cur[k]
    else cur[k] = v
  }
  ;(STORE[col] ??= {})[id] = cur
}
const ref = (col: string, id: string): any => ({ id, __col: col })
function snap(col: string, id: string, fields: string[] | null) {
  const d = STORE[col]?.[id]
  return {
    id,
    ref: ref(col, id),
    exists: !!d,
    data: () => (d && fields ? Object.fromEntries(fields.filter(f => f in d).map(f => [f, d[f]])) : d && { ...d }),
  }
}
let seq = 0
function query(col: string, filters: Array<[string, string, unknown]> = [], fields: string[] | null = null): any {
  return {
    where: (f: string, op: string, v: unknown) => query(col, [...filters, [f, op, v]], fields),
    orderBy: () => query(col, filters, fields),
    limit: () => query(col, filters, fields),
    select: (...fs: string[]) => query(col, filters, fs),
    add: async (data: Doc) => {
      const id = `new-${++seq}`
      apply(col, id, data, false)
      return ref(col, id)
    },
    get: async () => {
      const rows = STORE[col] ?? {}
      const docs = Object.keys(rows)
        .filter(id => filters.every(([f, op, v]) => (op === '==' ? millisOf(rows[id]![f]) === millisOf(v) : millisOf(rows[id]![f]) >= millisOf(v))))
        .map(id => snap(col, id, fields))
      return { docs, size: docs.length, empty: !docs.length }
    },
  }
}
const db: any = {
  collection: (col: string) => query(col),
  getAll: async (...refs: any[]) => refs.map(r => snap(r.__col, r.id, null)),
  batch: () => {
    const ops: Array<() => void> = []
    return {
      set: (r: any, patch: Doc, opts?: { merge?: boolean }) => { ops.push(() => apply(r.__col, r.id, patch, !!opts?.merge)) },
      commit: async () => { for (const op of ops) op() },
    }
  },
}

// ── 情境 ─────────────────────────────────────────────────────────
const WS = 'ws1'
// 查單（正式站原句）：三句向量很像（同一組）
const PAY_STATUS = '請問這張訂單的付款狀態是？'
const PAY_DONE = '請問這張訂單的付款完成了嗎？'
const CHASE = '您好請問有消息嗎？從一開始反應到現在都過半年了'
// 一般問題：跟查單那組向量也很像（比得到同一筆），但問的是規則
const PAY_METHOD = '請問可以用網路銀行轉帳付款嗎？'
const PAY_ATM = '請問付款方式有 ATM 嗎？'
// 另一組一般問題（對照組）
const FILTER = '濾網有沒有賣備品？'
const FILTER2 = '請問濾網可以單買嗎'

const VECTORS: Record<string, number[]> = {
  [PAY_STATUS]: [1, 0, 0],
  [PAY_DONE]: [0.99, 0.1, 0],
  [CHASE]: [0.98, 0.15, 0],
  [PAY_METHOD]: [0.98, 0.12, 0],
  [PAY_ATM]: [0.99, 0.08, 0],
  [FILTER]: [0, 0, 1],
  [FILTER2]: [0, 0.05, 0.99],
}
const vectorOf = (q: string) => VECTORS[q] ?? [0, 1, 0]

function seedEvents(counts: Record<string, number>) {
  STORE.aiHandoffEvents = {}
  let n = 0
  for (const [query, times] of Object.entries(counts)) {
    for (let i = 0; i < times; i++) {
      STORE.aiHandoffEvents[`e${++n}`] = {
        workspaceId: WS,
        query,
        reason: 'no_grounding',
        createdAt: { toMillis: () => Date.now() - 3600_000 },
        sources: [],
      }
    }
  }
}

function seedSuggestion(id: string, extra: Doc) {
  ;(STORE.knowledgeSuggestions ??= {})[id] = {
    workspaceId: WS,
    status: 'pending',
    topic: '付款狀態',
    topicIsRaw: false,
    queries: [PAY_STATUS, PAY_DONE],
    sampleQueries: [PAY_STATUS, PAY_DONE],
    eventCount: 3,
    centroid: h.FieldValue.vector([1, 0.05, 0]),
    draft: null,
    blanksCount: 0,
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
  vi.mocked(embedQuery).mockImplementation(async (q: string) => vectorOf(q))
  vi.mocked(generateJson).mockResolvedValue({
    data: { topic: '濾網備品', title: '濾網可以單買', content: '【請填寫：價格】', tags: [], questions: [] },
    inputTokens: 10,
    outputTokens: 10,
  } as any)
})

describe('查單的問題不列（C-318）', () => {
  it('① 新出現的查單那一組：不建建議、不擬草稿，記進 tally', async () => {
    seedEvents({ [PAY_STATUS]: 2, [PAY_DONE]: 1, [CHASE]: 1 })

    const tally = await scanWorkspaceKnowledgeGaps(db, WS)

    expect(tally).toMatchObject({ created: 0, skippedPersonalOrder: 1 })
    expect(STORE.knowledgeSuggestions ?? {}).toEqual({})
    expect(generateJson).not.toHaveBeenCalled()
  })

  it('⑤ 對照組：一般問題照舊建建議，跟查單那一組在同一輪也一樣', async () => {
    seedEvents({ [PAY_STATUS]: 2, [PAY_DONE]: 1, [FILTER]: 2, [FILTER2]: 1 })

    const tally = await scanWorkspaceKnowledgeGaps(db, WS)

    expect(tally).toMatchObject({ created: 1, skippedPersonalOrder: 1 })
    const [doc] = Object.values(STORE.knowledgeSuggestions!)
    expect(doc!.queries).toEqual([FILTER, FILTER2])
  })

  it('② 清單上已經有的、這輪比對到：收掉（原因 personal_order、180 天 TTL），次數寫這輪的', async () => {
    seedEvents({ [PAY_STATUS]: 3, [PAY_DONE]: 2 })
    seedSuggestion('s1', {})

    const tally = await scanWorkspaceKnowledgeGaps(db, WS)

    expect(tally).toMatchObject({ closedPersonalOrder: 1, updated: 0, created: 0 })
    const s1 = STORE.knowledgeSuggestions!.s1!
    expect(s1).toMatchObject({ status: 'dismissed', dismissReason: 'personal_order', eventCount: 5, seenCountAtDismiss: 5 })
    expect(s1.expireAt?.toMillis()).toBeGreaterThan(Date.now())
  })

  it('② 清單上已經有的、這輪一個事件都沒有（滑出窗口）：照存著的題目收掉', async () => {
    seedSuggestion('s1', {})
    seedSuggestion('s2', { queries: [FILTER, FILTER2], sampleQueries: [FILTER, FILTER2], topic: '濾網', centroid: h.FieldValue.vector([0, 0, 1]) })

    const tally = await scanWorkspaceKnowledgeGaps(db, WS)

    expect(tally.closedPersonalOrder).toBe(1)
    expect(STORE.knowledgeSuggestions!.s1).toMatchObject({ status: 'dismissed', dismissReason: 'personal_order' })
    // 一般問題那筆不動
    expect(STORE.knowledgeSuggestions!.s2!.status).toBe('pending')
    expect(STORE.knowledgeSuggestions!.s2!.dismissReason).toBeUndefined()
  })

  it('② 正在採用中的（accepting）不動', async () => {
    seedEvents({ [PAY_STATUS]: 3, [PAY_DONE]: 2 })
    seedSuggestion('s1', { status: 'accepting' })

    await scanWorkspaceKnowledgeGaps(db, WS)

    expect(STORE.knowledgeSuggestions!.s1!.status).toBe('accepting')
  })
})

describe('兩種收法之後，同一類再出現（C-318）', () => {
  const generalGroup = { queries: [FILTER, FILTER2], sampleQueries: [FILTER, FILTER2], topic: '濾網', centroid: h.FieldValue.vector([0, 0.02, 1]) }

  it('③ 交給真人就好：次數翻了好幾倍也不再列', async () => {
    seedEvents({ [FILTER]: 20, [FILTER2]: 10 })
    seedSuggestion('s1', { ...generalGroup, status: 'dismissed', dismissReason: 'handoff', seenCountAtDismiss: 3 })

    const tally = await scanWorkspaceKnowledgeGaps(db, WS)

    expect(tally).toMatchObject({ reopened: 0, created: 0 })
    expect(STORE.knowledgeSuggestions!.s1!.status).toBe('dismissed')
  })

  it('③ 不用管：照舊翻倍才再列（沒翻倍不列）', async () => {
    seedEvents({ [FILTER]: 3, [FILTER2]: 2 })
    seedSuggestion('s1', { ...generalGroup, status: 'dismissed', dismissReason: 'ignore', seenCountAtDismiss: 3 })
    expect((await scanWorkspaceKnowledgeGaps(db, WS)).reopened).toBe(0)
    expect(STORE.knowledgeSuggestions!.s1!.status).toBe('dismissed')

    seedEvents({ [FILTER]: 4, [FILTER2]: 2 })
    expect((await scanWorkspaceKnowledgeGaps(db, WS)).reopened).toBe(1)
    expect(STORE.knowledgeSuggestions!.s1).toMatchObject({ status: 'pending', eventCount: 6 })
    expect(STORE.knowledgeSuggestions!.s1!.dismissReason).toBeUndefined()
  })

  it('③ 舊資料沒有 dismissReason＝不用管（翻倍才列）', async () => {
    seedEvents({ [FILTER]: 4, [FILTER2]: 2 })
    seedSuggestion('s1', { ...generalGroup, status: 'dismissed', seenCountAtDismiss: 3 })

    expect((await scanWorkspaceKnowledgeGaps(db, WS)).reopened).toBe(1)
  })

  it('③ 不用管過的查單那一類：翻倍也不放回來', async () => {
    seedEvents({ [PAY_STATUS]: 10, [PAY_DONE]: 10 })
    seedSuggestion('s1', { status: 'dismissed', dismissReason: 'ignore', seenCountAtDismiss: 3 })

    expect((await scanWorkspaceKnowledgeGaps(db, WS)).reopened).toBe(0)
    expect(STORE.knowledgeSuggestions!.s1!.status).toBe('dismissed')
  })

  it('④ 系統收掉的查單題目：同一類還是查單 → 繼續不列；現在問的是一般問題 → 放回清單（不用等翻倍）', async () => {
    seedEvents({ [PAY_STATUS]: 2, [PAY_DONE]: 1 })
    seedSuggestion('s1', { status: 'dismissed', dismissReason: 'personal_order', seenCountAtDismiss: 3 })
    expect((await scanWorkspaceKnowledgeGaps(db, WS)).reopened).toBe(0)
    expect(STORE.knowledgeSuggestions!.s1!.status).toBe('dismissed')

    seedEvents({ [PAY_METHOD]: 1, [PAY_ATM]: 1 })
    expect((await scanWorkspaceKnowledgeGaps(db, WS)).reopened).toBe(1)
    const s1 = STORE.knowledgeSuggestions!.s1!
    expect(s1).toMatchObject({ status: 'pending', eventCount: 2, queries: [PAY_METHOD, PAY_ATM] })
    expect(s1.dismissReason).toBeUndefined()
    expect(s1.expireAt).toBeUndefined()
  })
})
