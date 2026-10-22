/**
 * 客服剛按「結束會話」／「交還機器人」，客人 30 分鐘內接著講 → 先交給真人（`C-382`，老闆 2026-10-22「Ok」）。
 *
 * 要釘住的：
 *  - 只有客服自己按的那一顆會蓋「什麼時候放手的」；批次結束、排程自動交還、排程自動結束都不蓋（還會清掉舊的）
 *  - 放手後 30 分鐘內：按結束的→新開的那一場放回待真人並標成上一場的尾巴；按交還的→同一場放回待真人
 *  - 統計那一族一個都不碰；尾巴那一場不進對話統計（不算真人首接、也不算沒人回）
 *  - 「這位客人是真人的」記號蓋回去；放手時間用過就收掉——兩則同時進來只觸發一次
 *  - 超過 30 分鐘 → 不動
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms, toMillis: () => ms }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('uuid', () => ({ v4: () => 'new-session-id' }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn() }))

import {
  closeConversationSession,
  handBackSessionToBot,
  readHumanRelease,
  returnReleasedSessionToPending,
} from './conversation-session'
import { getDb } from './firebase'
import { buildDaysFromSessions } from './conversation-stats-rollup'

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'
const CONV_ID = `${WS}_${LINE_UID}`
const NOW = 1_770_000_000_000
const MIN = 60_000
const WINDOW = 30 * MIN

const ts = (ms: number) => ({ toMillis: () => ms })

/**
 * 假 Firestore：對話與會話都存在記憶體裡，寫進去會真的改到（FieldValue.delete() 會真的刪掉欄位），
 * 交易裡讀到的就是當下的內容——連打兩次，第二次讀到的就是第一次寫完的樣子（跟並發 webhook 一樣）。
 */
function makeDb(init: { sessions: Record<string, Record<string, any>>, conv: Record<string, any> }) {
  const state = {
    sessions: Object.fromEntries(Object.entries(init.sessions).map(([id, s]) => [id, { ...s }])) as Record<string, Record<string, any>>,
    convs: { [CONV_ID]: { ...init.conv } } as Record<string, Record<string, any>>,
    events: [] as Record<string, any>[],
    convWrites: [] as Record<string, any>[],
    sessionWrites: [] as Record<string, any>[],
  }
  const apply = (target: Record<string, any>, patch: Record<string, any>) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === '__del__') delete target[k]
      else target[k] = v
    }
  }
  const write = (col: string, id: string, patch: Record<string, any>) => {
    if (col === 'conversations') {
      state.convWrites.push(patch)
      state.convs[id] = state.convs[id] ?? {}
      apply(state.convs[id]!, patch)
    }
    if (col === 'conversationSessions') {
      state.sessionWrites.push(patch)
      apply(state.sessions[id]!, patch)
    }
    if (col === 'conversationEvents') state.events.push(patch)
  }
  const read = (col: string, id: string) => {
    const data = col === 'conversations' ? state.convs[id] : state.sessions[id]
    return { exists: !!data, data: () => (data ? { ...data } : undefined) }
  }
  const docFor = (col: string, id: string) => ({
    __col: col,
    __id: id,
    get: vi.fn(async () => read(col, id)),
    set: vi.fn(async (patch: Record<string, any>) => write(col, id, patch)),
    update: vi.fn(async (patch: Record<string, any>) => write(col, id, patch)),
  })
  let autoId = 0
  /**
   * 交易一個接一個跑：真的 Firestore 遇到兩個交易同時改同一份文件，後到的那個會重跑、讀到前一個寫完的樣子。
   * 假 db 沒有重跑機制，用排隊模擬同一個結果（不排隊的話兩個都讀到舊值，測的是一個不存在的世界）。
   */
  let txQueue: Promise<unknown> = Promise.resolve()
  const db = {
    collection: (col: string) => ({ doc: (id?: string) => docFor(col, id ?? `auto-${++autoId}`) }),
    batch: () => {
      const queued: { ref: any, patch: Record<string, any> }[] = []
      return {
        set: (ref: any, patch: Record<string, any>) => { queued.push({ ref, patch }) },
        update: (ref: any, patch: Record<string, any>) => { queued.push({ ref, patch }) },
        commit: vi.fn(async () => { for (const w of queued) write(w.ref.__col, w.ref.__id, w.patch) }),
      }
    },
    runTransaction: vi.fn((fn: (tx: any) => Promise<any>) => {
      const run = txQueue.then(() => fn({
        get: async (ref: any) => read(ref.__col, ref.__id),
        update: (ref: any, patch: Record<string, any>) => write(ref.__col, ref.__id, patch),
        set: (ref: any, patch: Record<string, any>) => write(ref.__col, ref.__id, patch),
      }))
      txQueue = run.catch(() => {})
      return run
    }),
  }
  return { db, state }
}

/** 同事回完、還沒放手的那一場 */
function humanSession(extra: Record<string, any> = {}) {
  return {
    workspaceId: WS,
    userId: LINE_UID,
    status: 'human_handling',
    initialHandler: 'bot',
    initialModuleType: 'bot_flow',
    hasHandoff: true,
    handoffRequestedAt: ts(NOW - 20 * MIN),
    humanFirstRepliedAt: ts(NOW - 15 * MIN),
    humanLastRepliedAt: ts(NOW - 1 * MIN),
    lastActivityAt: ts(NOW - 1 * MIN),
    ...extra,
  }
}

/** 客人在客服按結束之後講話，ensureConversationSession 新開的那一場（機器人還沒碰） */
function newOpenSession() {
  return {
    workspaceId: WS,
    userId: LINE_UID,
    status: 'open',
    initialHandler: 'unhandled',
    currentHandler: 'unhandled',
    initialModuleType: null,
    hasHandoff: false,
    handoffRequestedAt: null,
    humanFirstRepliedAt: null,
    origin: 'message',
    hasInbound: true,
    openedAt: ts(NOW),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

describe('放手時蓋不蓋「什麼時候放手的」', () => {
  it('客服按「結束會話」→ 清「真人的」記號的同一筆寫入，蓋放手時間＋按了哪一顆', async () => {
    const { db, state } = makeDb({ sessions: { s1: humanSession() }, conv: { currentSessionId: 's1', lastHumanActionAt: ts(NOW - MIN) } })
    vi.mocked(getDb).mockReturnValue(db as any)

    await closeConversationSession('s1', LINE_UID, { byStaff: true })

    const convWrite = state.convWrites.find(w => 'lastHumanActionAt' in w)!
    expect(convWrite).toMatchObject({ lastHumanActionAt: '__del__', humanReleasedAt: '__ts__', humanReleasedBy: 'close' })
  })

  it('批次結束（沒帶 byStaff）→ 不蓋，而且把舊的放手時間清掉', async () => {
    const { db, state } = makeDb({
      sessions: { s1: humanSession() },
      conv: { currentSessionId: 's1', humanReleasedAt: ts(NOW - 5 * MIN), humanReleasedBy: 'handback' },
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    await closeConversationSession('s1', LINE_UID)

    expect(state.convs[CONV_ID]).not.toHaveProperty('humanReleasedAt')
    expect(state.convs[CONV_ID]).not.toHaveProperty('humanReleasedBy')
  })

  it.each(['idle_auto', 'idle_bot_auto'] as const)('排程自動結束（%s）→ 不碰放手時間（也不清「真人的」記號）', async (reason) => {
    const { db, state } = makeDb({ sessions: { s1: humanSession() }, conv: { currentSessionId: 's1', lastHumanActionAt: ts(NOW - MIN) } })
    vi.mocked(getDb).mockReturnValue(db as any)

    await closeConversationSession('s1', LINE_UID, { reason })

    for (const w of state.convWrites) {
      expect(w).not.toHaveProperty('humanReleasedAt')
      expect(w).not.toHaveProperty('lastHumanActionAt')
    }
  })

  it('客服按「交還機器人」→ 蓋放手時間＋handback', async () => {
    const { db, state } = makeDb({ sessions: { s1: humanSession() }, conv: { currentSessionId: 's1' } })
    vi.mocked(getDb).mockReturnValue(db as any)

    await handBackSessionToBot('s1', LINE_UID, { byStaff: true })

    expect(state.convs[CONV_ID]).toMatchObject({ humanReleasedAt: '__ts__', humanReleasedBy: 'handback' })
  })

  it('排程自動交還（沒帶 byStaff）→ 不蓋，而且清掉舊的', async () => {
    const { db, state } = makeDb({
      sessions: { s1: humanSession() },
      conv: { currentSessionId: 's1', humanReleasedAt: ts(NOW - 5 * MIN), humanReleasedBy: 'close' },
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    await handBackSessionToBot('s1', LINE_UID)

    expect(state.convs[CONV_ID]).not.toHaveProperty('humanReleasedAt')
  })

  it('readHumanRelease 讀得出時間與哪一顆；沒有就 null', async () => {
    const { db, state } = makeDb({ sessions: {}, conv: { humanReleasedAt: ts(NOW - 3 * MIN), humanReleasedBy: 'handback' } })
    vi.mocked(getDb).mockReturnValue(db as any)
    expect(await readHumanRelease(LINE_UID, WS)).toEqual({ atMs: NOW - 3 * MIN, by: 'handback' })

    delete state.convs[CONV_ID]!.humanReleasedAt
    expect(await readHumanRelease(LINE_UID, WS)).toBeNull()
  })
})

describe('returnReleasedSessionToPending：放手後 30 分鐘內客人接著講', () => {
  it('按「結束」3 分鐘後：新開的那一場放回待真人、標成上一場的尾巴、蓋回「真人的」記號、收掉放手時間', async () => {
    const releasedAt = NOW - 3 * MIN
    const { db, state } = makeDb({
      sessions: { s2: newOpenSession() },
      conv: { currentSessionId: 's2', humanReleasedAt: ts(releasedAt), humanReleasedBy: 'close' },
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    const res = await returnReleasedSessionToPending('s2', LINE_UID, WS, { atMs: NOW, windowMs: WINDOW })

    expect(res).toEqual({ by: 'close', afterMinutes: 3 })
    expect(state.sessions.s2).toMatchObject({
      status: 'pending_human',
      currentHandler: 'human',
      continuesHumanSession: true,
      returnedAfterRelease: 'close',
    })
    expect(state.sessions.s2!.customerReturnedAt.toMillis()).toBe(NOW)
    expect(state.convs[CONV_ID]!.lastHumanActionAt.toMillis()).toBe(releasedAt)
    expect(state.convs[CONV_ID]).not.toHaveProperty('humanReleasedAt')
    expect(state.events).toEqual([expect.objectContaining({
      eventType: 'customer_returned', releasedBy: 'close', afterMinutes: 3,
    })])
  })

  it('⛔ 統計那一族一個都不碰（不是又一次轉真人、也不是首接）', async () => {
    const { db, state } = makeDb({
      sessions: { s2: newOpenSession() },
      conv: { currentSessionId: 's2', humanReleasedAt: ts(NOW - MIN), humanReleasedBy: 'close' },
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    await returnReleasedSessionToPending('s2', LINE_UID, WS, { atMs: NOW, windowMs: WINDOW })

    for (const key of ['initialHandler', 'initialModuleType', 'hasHandoff', 'handoffRequestedAt', 'humanFirstRepliedAt']) {
      expect(state.sessionWrites[0]).not.toHaveProperty(key)
    }
  })

  it('尾巴那一場不進對話統計：不算真人首接、也不算沒人回', () => {
    const openedAt = { toMillis: () => NOW, toDate: () => new Date(NOW) }
    const days = buildDaysFromSessions([
      { ...newOpenSession(), openedAt, status: 'pending_human', continuesHumanSession: true },
      { ...newOpenSession(), openedAt, status: 'human_handling', continuesHumanSession: true, initialHandler: 'human' },
      // 對照：一般的新對話照算
      { ...newOpenSession(), openedAt },
    ])
    const day = [...days.values()][0]!
    expect(day.total).toBe(1)
    expect(day.unhandled).toBe(1)
    expect(day.human).toBe(0)
  })

  it('按「交還機器人」：同一場（機器人處理中）放回待真人，不標尾巴（這一場本來就算過了）', async () => {
    const { db, state } = makeDb({
      sessions: { s1: humanSession({ status: 'bot_handling', currentHandler: 'bot' }) },
      conv: { currentSessionId: 's1', humanReleasedAt: ts(NOW - 10 * MIN), humanReleasedBy: 'handback' },
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    const res = await returnReleasedSessionToPending('s1', LINE_UID, WS, { atMs: NOW, windowMs: WINDOW })

    expect(res).toEqual({ by: 'handback', afterMinutes: 10 })
    expect(state.sessions.s1).toMatchObject({ status: 'pending_human', returnedAfterRelease: 'handback' })
    expect(state.sessions.s1).not.toHaveProperty('continuesHumanSession')
  })

  it('超過 30 分鐘 → 不動（照舊交給 AI）', async () => {
    const { db, state } = makeDb({
      sessions: { s2: newOpenSession() },
      conv: { currentSessionId: 's2', humanReleasedAt: ts(NOW - 31 * MIN), humanReleasedBy: 'close' },
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    expect(await returnReleasedSessionToPending('s2', LINE_UID, WS, { atMs: NOW, windowMs: WINDOW })).toBeNull()
    expect(state.sessionWrites).toHaveLength(0)
    expect(state.events).toHaveLength(0)
  })

  it('從來沒放手過（或排程放的、沒蓋時間）→ 不動', async () => {
    const { db, state } = makeDb({ sessions: { s2: newOpenSession() }, conv: { currentSessionId: 's2' } })
    vi.mocked(getDb).mockReturnValue(db as any)

    expect(await returnReleasedSessionToPending('s2', LINE_UID, WS, { atMs: NOW, windowMs: WINDOW })).toBeNull()
    expect(state.sessionWrites).toHaveLength(0)
  })

  it('同一刻進來兩則 → 只有第一則觸發，只記一筆事件', async () => {
    const { db, state } = makeDb({
      sessions: { s2: newOpenSession() },
      conv: { currentSessionId: 's2', humanReleasedAt: ts(NOW - MIN), humanReleasedBy: 'close' },
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    const results = await Promise.all([
      returnReleasedSessionToPending('s2', LINE_UID, WS, { atMs: NOW, windowMs: WINDOW }),
      returnReleasedSessionToPending('s2', LINE_UID, WS, { atMs: NOW, windowMs: WINDOW }),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(state.events).toHaveLength(1)
  })

  it.each(['pending_human', 'human_handling', 'closed'])('這一場已經不是機器人在處理（%s）→ 不動', async (status) => {
    const { db, state } = makeDb({
      sessions: { s2: { ...newOpenSession(), status } },
      conv: { currentSessionId: 's2', humanReleasedAt: ts(NOW - MIN), humanReleasedBy: 'close' },
    })
    vi.mocked(getDb).mockReturnValue(db as any)

    expect(await returnReleasedSessionToPending('s2', LINE_UID, WS, { atMs: NOW, windowMs: WINDOW })).toBeNull()
    expect(state.sessionWrites).toHaveLength(0)
  })
})
