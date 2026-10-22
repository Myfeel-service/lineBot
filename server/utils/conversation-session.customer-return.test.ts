/**
 * 真人處理中、客服一陣子沒回，客人又來講話 → 放回待真人（`C-381`）。
 *
 * 要釘住的：
 *  - 放得回去的只有「真人處理中、客服上一則已超過門檻」那一種，而且只放一次
 *  - 統計那一族欄位（首接、轉真人）一個都不碰——客人回來不是又一次轉真人
 *  - 客服接著回話 → 回到真人處理中，不可以順手補記一次「轉真人」
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
  Timestamp: { fromMillis: (m: number) => ({ __ms: m, toMillis: () => m }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-session-id' }))

import {
  getSessionStatusCached,
  onHumanOutgoingMessage,
  returnHumanSessionToPending,
} from './conversation-session'
import { getDb } from './firebase'

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'
const NOW = 1_770_000_000_000
const MIN = 60_000
const IDLE_30 = 30 * MIN

const ts = (ms: number) => ({ toMillis: () => ms })

/**
 * 假 Firestore：一份 session 文件，交易內讀到的是「目前」的內容（寫進去會真的改到），
 * 所以同一份資料連打兩次，第二次讀到的就是第一次寫完的樣子——跟並發 webhook 一樣。
 */
function makeDb(session: Record<string, any>) {
  const doc = { ...session }
  const patches: Record<string, any>[] = []
  const events: Array<{ eventType: string, sessionId: string }> = []
  const apply = (patch: Record<string, any>) => {
    patches.push(patch)
    for (const [k, v] of Object.entries(patch)) {
      if (v === '__del__') delete doc[k]
      else doc[k] = v
    }
  }
  const db = {
    collection: (col: string) => ({
      doc: (_id?: string) => ({
        __col: col,
        get: vi.fn(async () => (col === 'conversations'
          ? { exists: true, data: () => ({ currentSessionId: 'sess-1' }) }
          : { exists: true, data: () => ({ ...doc }) })),
        set: vi.fn(async (data: any) => { if (col === 'conversationEvents') events.push(data) }),
        update: vi.fn(async (patch: any) => { if (col === 'conversationSessions') apply(patch) }),
      }),
    }),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn({
      get: async (ref: any) => (ref.__col === 'conversations'
        ? { exists: true, data: () => ({ currentSessionId: 'sess-1' }) }
        : { exists: true, data: () => ({ ...doc }) }),
      update: (ref: any, patch: Record<string, any>) => {
        if (ref.__col === 'conversationSessions') apply(patch)
      },
    })),
  }
  return { db, doc, patches, events }
}

/** 一場「同事三天前接手、回過話、還沒結束」的真人處理中 */
function staleHumanSession(extra: Record<string, any> = {}) {
  return {
    workspaceId: WS,
    userId: LINE_UID,
    status: 'human_handling',
    initialHandler: 'bot',
    initialModuleType: 'bot_flow',
    currentHandler: 'human',
    hasHandoff: true,
    handoffRequestedAt: ts(NOW - 3 * 24 * 60 * MIN),
    humanFirstRepliedAt: ts(NOW - 3 * 24 * 60 * MIN),
    humanLastRepliedAt: ts(NOW - 3 * 24 * 60 * MIN),
    slaRemindedAt: ts(NOW - 3 * 24 * 60 * MIN),
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

describe('returnHumanSessionToPending：客人回來，放回待真人', () => {
  it('客服三天沒回、客人又來 → 回到待真人，記下回來的時間、拆掉上次的提醒章', async () => {
    const { db, doc, events } = makeDb(staleHumanSession())
    vi.mocked(getDb).mockReturnValue(db as any)

    const ok = await returnHumanSessionToPending('sess-1', LINE_UID, WS, { atMs: NOW - 1000, minStaffIdleMs: IDLE_30 })

    expect(ok).toBe(true)
    expect(doc.status).toBe('pending_human')
    expect(doc.customerReturnedAt.toMillis()).toBe(NOW - 1000)
    // 上一次等真人時蓋過的章不拆，這次就永遠不會再提醒
    expect(doc).not.toHaveProperty('slaRemindedAt')
    expect(events.map(e => e.eventType)).toEqual(['customer_returned'])
    // 本行程的狀態快取同步成待真人：接下來送「已收到」那支看的就是它
    expect(await getSessionStatusCached('sess-1')).toBe('pending_human')
  })

  it('⛔ 統計那一族一個都不碰（客人回來不是又一次轉真人）', async () => {
    const { db, patches } = makeDb(staleHumanSession())
    vi.mocked(getDb).mockReturnValue(db as any)

    await returnHumanSessionToPending('sess-1', LINE_UID, WS, { minStaffIdleMs: IDLE_30 })

    for (const key of ['initialHandler', 'initialModuleType', 'hasHandoff', 'handoffRequestedAt', 'humanFirstRepliedAt', 'currentHandler']) {
      expect(patches[0]).not.toHaveProperty(key)
    }
  })

  it('客服 30 分鐘內才回過話 → 不動（他多半還在線上一來一往）', async () => {
    const { db, doc, events } = makeDb(staleHumanSession({ humanLastRepliedAt: ts(NOW - 10 * MIN) }))
    vi.mocked(getDb).mockReturnValue(db as any)

    const ok = await returnHumanSessionToPending('sess-1', LINE_UID, WS, { atMs: NOW, minStaffIdleMs: IDLE_30 })

    expect(ok).toBe(false)
    expect(doc.status).toBe('human_handling')
    expect(events).toHaveLength(0)
  })

  it('延續真人開場的場（沒有首接時間）看 humanLastRepliedAt：真人那次動作夠久了就放回去', async () => {
    const { db, doc } = makeDb(staleHumanSession({
      humanFirstRepliedAt: null,
      hasHandoff: false,
      humanLastRepliedAt: ts(NOW - 6 * 24 * 60 * MIN),
    }))
    vi.mocked(getDb).mockReturnValue(db as any)

    expect(await returnHumanSessionToPending('sess-1', LINE_UID, WS, { minStaffIdleMs: IDLE_30 })).toBe(true)
    expect(doc.status).toBe('pending_human')
  })

  it.each(['pending_human', 'bot_handling', 'open', 'closed'])('不是真人處理中（%s）→ 不動', async (status) => {
    const { db, patches } = makeDb(staleHumanSession({ status }))
    vi.mocked(getDb).mockReturnValue(db as any)

    expect(await returnHumanSessionToPending('sess-1', LINE_UID, WS, { minStaffIdleMs: IDLE_30 })).toBe(false)
    expect(patches).toHaveLength(0)
  })

  it('同一刻進來好幾則（客人一次傳五張圖）→ 只有第一則放得回去、只記一筆事件', async () => {
    const { db, events } = makeDb(staleHumanSession())
    vi.mocked(getDb).mockReturnValue(db as any)

    const results = []
    for (let i = 0; i < 5; i++) {
      results.push(await returnHumanSessionToPending('sess-1', LINE_UID, WS, { minStaffIdleMs: IDLE_30 }))
    }

    expect(results).toEqual([true, false, false, false, false])
    expect(events).toHaveLength(1)
  })
})

describe('onHumanOutgoingMessage：客服接回放回待真人的那一場', () => {
  it('回到真人處理中、蓋真人最後回覆時間、收掉回來的時間——不重記首接', async () => {
    const { db, doc, events } = makeDb(staleHumanSession({
      status: 'pending_human',
      customerReturnedAt: ts(NOW - 50 * MIN),
    }))
    vi.mocked(getDb).mockReturnValue(db as any)

    await onHumanOutgoingMessage(LINE_UID, WS)

    expect(doc.status).toBe('human_handling')
    expect(doc.humanLastRepliedAt).toBe('__ts__')
    expect(doc).not.toHaveProperty('customerReturnedAt')
    expect(events).toHaveLength(0)
  })

  it('⛔ 客服直接接手、從沒轉過真人的場（hasHandoff=false）放回待真人後再回話 → 不可以補記一次轉真人', async () => {
    const { db, doc, patches, events } = makeDb(staleHumanSession({
      status: 'pending_human',
      initialHandler: 'human',
      initialModuleType: 'live_agent',
      hasHandoff: false,
      handoffRequestedAt: null,
      customerReturnedAt: ts(NOW - 50 * MIN),
    }))
    vi.mocked(getDb).mockReturnValue(db as any)

    await onHumanOutgoingMessage(LINE_UID, WS)

    expect(patches[0]).not.toHaveProperty('hasHandoff')
    expect(patches[0]).not.toHaveProperty('handoffRequestedAt')
    expect(doc.hasHandoff).toBe(false)
    expect(events.map(e => e.eventType)).not.toContain('handoff_request')
  })
})
