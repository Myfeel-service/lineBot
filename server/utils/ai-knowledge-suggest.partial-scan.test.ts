/**
 * `C-311`：只採用其中幾題之後，下一輪掃描怎麼對待那筆建議。
 *
 * 回答掉的題目，事件還會在 30 天窗口裡、照樣聚回同一組。這裡釘住：
 *  ① 回答過的不會被併回清單、次數只算剩下的、草稿照剩下的題目重擬（不是整組）、不會另開一筆重複的
 *  ② 忽略過的那筆，「次數翻倍才重新出現」也只看剩下的題目（回答過的題目再被問不算惡化）
 *  ③ 新主題開始存每題各被問幾次（部分採用靠它扣出真話）
 *  ④ 掃描讀既有建議時 select 有列到要讀的欄位（漏列＝讀回 undefined、不報錯，以前改名那段就是這樣從沒跑到過）
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

// ── 記憶體 Firestore（只做掃描會用到的；select 照實投影）─────────────
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
const ORIGIN = '請問一下小滑手咖啡機是哪一國做的？'
const ESPRESSO = '小滑手只能沖義式咖啡嗎？'
const FROTH = '小滑手咖啡機 能萃取咖啡液的同時打奶泡嗎'
const SIZE = '小滑手咖啡機 寬/深/高各多少'

/** 小滑手四題向量都很像（同一組）；其他句子跟它們正交 */
const VECTORS: Record<string, number[]> = {
  [ORIGIN]: [1, 0, 0],
  [ESPRESSO]: [0.99, 0.1, 0],
  [FROTH]: [0.98, 0.15, 0],
  [SIZE]: [0.99, 0.05, 0],
}
const vectorOf = (q: string) => VECTORS[q] ?? [0, 0, 1]

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

/** 部分採用（回答了「哪一國做的」）之後留下來的那筆 */
function seedPartiallyAccepted(extra: Doc = {}) {
  STORE.knowledgeSuggestions = {
    s1: {
      workspaceId: WS,
      status: 'pending',
      topic: ESPRESSO.slice(0, 12),
      topicIsRaw: true,
      queries: [ESPRESSO, FROTH, SIZE],
      queryCounts: [2, 1, 1],
      sampleQueries: [ESPRESSO, FROTH, SIZE],
      eventCount: 4,
      centroid: h.FieldValue.vector([1, 0.08, 0]),
      draft: null,
      blanksCount: 0,
      answeredQueries: [ORIGIN],
      ...extra,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
  vi.mocked(embedQuery).mockImplementation(async (q: string) => vectorOf(q))
  vi.mocked(generateJson).mockResolvedValue({
    data: { topic: '小滑手的功能與尺寸', title: '小滑手咖啡機的功能與尺寸', content: '只能沖義式；【請填寫：尺寸】', tags: [], questions: [] },
    inputTokens: 10,
    outputTokens: 10,
  } as any)
})

describe('部分採用之後的下一輪掃描（C-311）', () => {
  it('① 回答過的不併回、次數只算剩下的、照剩下的題目重擬、不另開一筆', async () => {
    seedEvents({ [ORIGIN]: 3, [ESPRESSO]: 2, [FROTH]: 1, [SIZE]: 1 })
    seedPartiallyAccepted()

    const tally = await scanWorkspaceKnowledgeGaps(db, WS)

    expect(tally).toMatchObject({ created: 0, updated: 1 })
    expect(Object.keys(STORE.knowledgeSuggestions!)).toEqual(['s1'])
    const s1 = STORE.knowledgeSuggestions!.s1!
    expect(s1.status).toBe('pending')
    expect(s1.queries).toEqual([ESPRESSO, FROTH, SIZE])
    expect(s1.sampleQueries).not.toContain(ORIGIN)
    expect(s1.queryCounts).toEqual([2, 1, 1])
    expect(s1.eventCount).toBe(4) // ⛔ 不是整組的 7
    // 草稿照剩下的題目重擬，名字換成 AI 起的
    const prompt = String(vi.mocked(generateJson).mock.calls[0]![0])
    expect(prompt).toContain(ESPRESSO)
    expect(prompt).not.toContain(ORIGIN)
    expect(s1.draft?.title).toBe('小滑手咖啡機的功能與尺寸')
    expect(s1).toMatchObject({ topic: '小滑手的功能與尺寸', topicIsRaw: false })
  })

  it('① 剩下的題目這輪都沒人問（只剩回答過的在窗口裡）→ 那筆不動，也不另開一筆', async () => {
    // 窗口裡只剩回答過的「哪一國做的」（被問 3 次，夠成一組、也比得到 s1）
    seedEvents({ [ORIGIN]: 3 })
    seedPartiallyAccepted()
    const before = { ...STORE.knowledgeSuggestions!.s1! }

    const tally = await scanWorkspaceKnowledgeGaps(db, WS)

    expect(tally.created).toBe(0)
    expect(STORE.knowledgeSuggestions!.s1).toEqual(before)
  })

  it('② 忽略過的：回答過的題目再被問很多次，不算「次數翻倍」、不重新出現', async () => {
    seedEvents({ [ORIGIN]: 20, [ESPRESSO]: 2, [FROTH]: 1, [SIZE]: 1 })
    seedPartiallyAccepted({ status: 'dismissed', seenCountAtDismiss: 4 })

    const tally = await scanWorkspaceKnowledgeGaps(db, WS)

    expect(tally.reopened).toBe(0)
    expect(STORE.knowledgeSuggestions!.s1!.status).toBe('dismissed')
  })

  it('② 忽略過的：剩下的題目真的翻倍了才重新出現，而且清單上沒有回答過的那題', async () => {
    seedEvents({ [ORIGIN]: 1, [ESPRESSO]: 6, [FROTH]: 1, [SIZE]: 1 })
    seedPartiallyAccepted({ status: 'dismissed', seenCountAtDismiss: 4 })

    const tally = await scanWorkspaceKnowledgeGaps(db, WS)

    expect(tally.reopened).toBe(1)
    const s1 = STORE.knowledgeSuggestions!.s1!
    expect(s1).toMatchObject({ status: 'pending', eventCount: 8, queries: [ESPRESSO, FROTH, SIZE], queryCounts: [6, 1, 1] })
  })

  it('③ 新主題存下每題各被問幾次（跟 queries 同順序）', async () => {
    seedEvents({ [ORIGIN]: 3, [ESPRESSO]: 2 })

    await scanWorkspaceKnowledgeGaps(db, WS)

    const [doc] = Object.values(STORE.knowledgeSuggestions!)
    expect(doc).toMatchObject({ queries: [ORIGIN, ESPRESSO], queryCounts: [3, 2], eventCount: 5 })
  })

  it('④ 早就有草稿、名字卻還是客人原句的舊資料：這輪改用草稿標題（以前 select 沒列 topic，這段從沒跑到）', async () => {
    seedEvents({ [ORIGIN]: 3, [ESPRESSO]: 2 })
    STORE.knowledgeSuggestions = {
      old: {
        workspaceId: WS,
        status: 'pending',
        topic: ORIGIN.slice(0, 12), // 舊資料：沒有 topicIsRaw
        queries: [ORIGIN, ESPRESSO],
        sampleQueries: [ORIGIN, ESPRESSO],
        eventCount: 5,
        centroid: h.FieldValue.vector([1, 0.05, 0]),
        draft: { title: '小滑手咖啡機的產地', content: '台灣製造', tags: [], questions: [] },
      },
    }

    await scanWorkspaceKnowledgeGaps(db, WS)

    expect(STORE.knowledgeSuggestions!.old).toMatchObject({ topic: '小滑手咖啡機的產地', topicIsRaw: false })
    expect(generateJson).not.toHaveBeenCalled()
  })
})
