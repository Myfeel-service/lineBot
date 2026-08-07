/**
 * 每日客服摘要的「一天一則」防重複測試（2026-08-07）。
 *
 * 原本的判重是「開頭讀一次整份 cronState、整批跑完才在最後寫回」，中間夾著設定讀取與
 * 推播——只要有第二個排程執行者（Cloud Scheduler 逾時重試、Lambda 併發、本機 dev 的
 * scheduledTasks）就會發出兩份一樣的摘要。改成逐 workspace 用交易認領當天名額。
 *
 * 要守住的行為：
 *  - 今天已認領 → 不再發
 *  - 認領要排在「時段還沒到 / 沒東西講 / 通知關閉」的判斷之後（否則會白白吃掉當天名額）
 *  - 推播丟例外 → 拆掉當天名額，下一輪重來
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }), delete: () => ({ __op: 'del' }) },
  Timestamp: { now: () => ({ __ts: 'now' }), fromMillis: (ms: number) => ({ __ts: ms }) },
}))

vi.mock('./ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  buildSourceClearFailure: () => ({}),
  clearSourceFailure: vi.fn(),
  markSourceOutdated: vi.fn(),
}))
vi.mock('./ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('./ai-knowledge-suggest', () => ({ KNOWLEDGE_SUGGESTIONS_COLLECTION: 'knowledgeSuggestions' }))
vi.mock('./ai-knowledge-autoapply', () => ({ tryAutoApplyMinorChange: vi.fn() }))
vi.mock('./ai-source-extractors', () => ({ extractUrlText: vi.fn() }))
vi.mock('./gsheet-sync', () => ({ syncGoogleSheetSource: vi.fn() }))
vi.mock('./conversation-session', () => ({ handBackSessionToBot: vi.fn() }))
vi.mock('./webhook-dedup', () => ({ WEBHOOK_EVENT_LOCKS_COLLECTION: 'webhookEventLocks' }))
vi.mock('./ai-handoff-notify', () => ({
  notifyHandoffToStaff: vi.fn(async () => true),
  notifyOverdueHandoffBatch: vi.fn(async () => true),
}))

const { pushMessage } = vi.hoisted(() => ({ pushMessage: vi.fn(async (..._a: any[]) => ({})) }))
vi.mock('./line', () => ({ pushMessage }))

const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))

import { dailyBacklogDigest } from './cron-maintenance'

const WS = 'WS'
// 台北 2026-08-07 11:00（UTC 03:00）→ digestHour 10 已到、digestHour 12 還沒到
const NOW = Date.UTC(2026, 7, 7, 3, 0, 0)
const TODAY = '2026-08-07'

function applyPatch(data: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if ((v as any)?.__op === 'del') delete data[k]
    else data[k] = v
  }
}

/**
 * @param pendingUserIds 掛在「等待真人」的客人（讓摘要有東西可講）
 * @param initialState   cronState/backlog-digest 的起始內容（快照與即時資料都有）
 * @param liveOnlyState  **只有交易讀得到**的內容 —— 模擬「掃描之後、認領之前，
 *                       另一個執行者搶先寫入」。快照刻意看不到，跟現場一樣。
 */
function makeDb(
  pendingUserIds: string[],
  initialState: Record<string, string> = {},
  liveOnlyState: Record<string, string> = {},
) {
  const snapshotState: Record<string, unknown> = { ...initialState }
  const state: Record<string, unknown> = { ...initialState, ...liveOnlyState }
  const stateWrites: Array<Record<string, unknown>> = []
  const stateRef = {
    id: 'backlog-digest',
    // 開頭那次讀取是快照，之後不會反映其他執行者的寫入
    get: async () => ({ data: () => ({ ...snapshotState }) }),
    set: async (patch: Record<string, unknown>) => {
      stateWrites.push(patch)
      applyPatch(state, patch)
    },
  }

  const sessionDocs = pendingUserIds.map((uid, i) => ({
    id: `s${i}`,
    data: () => ({
      workspaceId: WS,
      userId: uid,
      status: 'pending_human',
      handoffRequestedAt: { toMillis: () => NOW - 90 * 60_000 },
    }),
  }))

  const emptySnap = { size: 0, docs: [] as unknown[], empty: true }
  const query = (docs: unknown[]) => {
    const q: any = {
      where: () => q,
      limit: () => q,
      get: async () => ({ size: docs.length, docs, empty: !docs.length }),
    }
    return q
  }

  const db = {
    collection(name: string) {
      if (name === 'cronState') return { doc: () => stateRef }
      if (name === 'conversationSessions') {
        // 第一個查詢是 pending_human、第二個是 human_handling（本測試只餵前者）
        let call = 0
        const q: any = {
          where: (_f: string, _op: string, value: string) => {
            call++
            return value === 'pending_human' ? query(sessionDocs) : query([])
          },
          limit: () => q,
          get: async () => emptySnap,
        }
        return q
      }
      return query([])
    },
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn({
        get: async (_ref: any) => ({ data: () => ({ ...state }) }),
        set: (_ref: any, patch: Record<string, unknown>) => {
          stateWrites.push(patch)
          applyPatch(state, patch)
        },
      })
    },
  } as any

  return { db, state, stateWrites }
}

function settings(digestHour = 10, extra: Record<string, unknown> = {}) {
  return {
    handoffNotify: {
      enabled: true, lineUserIds: ['Sa', 'Sb'], mode: 'missed_only',
      slaRemindMinutes: 30, digestHour, ...extra,
    },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: '' },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  pushMessage.mockClear()
  pushMessage.mockResolvedValue({})
  getAiSettings.mockReset()
  getAiSettings.mockResolvedValue(settings())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('dailyBacklogDigest 一天一則', () => {
  it('有積壓且時段已到 → 發一則並記下今天', async () => {
    const { db, state } = makeDb(['U1', 'U2'])
    const tally = await dailyBacklogDigest(db)

    expect(pushMessage).toHaveBeenCalledTimes(2) // 兩個收件人 × 一則
    const text = (pushMessage.mock.calls[0]![1] as any)[0].text as string
    expect(text).toContain('📋 每日客服摘要')
    expect(text).toContain('2 位客人在「等待真人」')
    expect(state[WS]).toBe(TODAY)
    expect(tally).toMatchObject({ workspacesNotified: 1 })
  })

  it('今天已經發過 → 不再發（快照早退）', async () => {
    const { db } = makeDb(['U1'], { [WS]: TODAY })
    const tally = await dailyBacklogDigest(db)

    expect(pushMessage).not.toHaveBeenCalled()
    expect(tally).toMatchObject({ workspacesNotified: 0 })
  })

  it('另一個執行者在這一輪中間搶先認領 → 交易擋下，不會發第二份', async () => {
    // 快照是空的（所以早退擋不住，一定會走到認領），交易讀到的即時資料已被對手記上今天
    const { db } = makeDb(['U1'], {}, { [WS]: TODAY })
    const tally = await dailyBacklogDigest(db)

    expect(pushMessage).not.toHaveBeenCalled()
    expect(tally).toMatchObject({ workspacesNotified: 0 })
  })

  it('商家自選時段還沒到 → 不發，也不可以吃掉今天的名額', async () => {
    getAiSettings.mockResolvedValue(settings(12)) // 現在台北 11 點
    const { db, state } = makeDb(['U1'])
    const tally = await dailyBacklogDigest(db)

    expect(pushMessage).not.toHaveBeenCalled()
    expect(state[WS]).toBeUndefined() // 名額沒被吃掉，12 點那輪才發
    expect(tally).toMatchObject({ workspacesNotified: 0 })
  })

  it('通知關閉 / 名單為空 → 不發也不吃名額', async () => {
    getAiSettings.mockResolvedValue(settings(10, { enabled: false }))
    const { db, state } = makeDb(['U1'])
    await dailyBacklogDigest(db)
    expect(pushMessage).not.toHaveBeenCalled()
    expect(state[WS]).toBeUndefined()

    getAiSettings.mockResolvedValue(settings(10, { lineUserIds: [] }))
    const b = makeDb(['U1'])
    await dailyBacklogDigest(b.db)
    expect(pushMessage).not.toHaveBeenCalled()
    expect(b.state[WS]).toBeUndefined()
  })

  it('沒有任何待辦 → 不發（不是每天都要吵一次）', async () => {
    const { db, state } = makeDb([])
    const tally = await dailyBacklogDigest(db)

    expect(pushMessage).not.toHaveBeenCalled()
    expect(state[WS]).toBeUndefined()
    expect(tally).toMatchObject({ workspacesNotified: 0 })
  })

  it('推播丟例外 → 拆掉今天的名額，下一輪重來', async () => {
    pushMessage.mockImplementation(() => { throw new Error('憑證掛了') })
    const { db, state } = makeDb(['U1'])
    const tally = await dailyBacklogDigest(db)

    expect(state[WS]).toBeUndefined()
    expect(tally).toMatchObject({ workspacesNotified: 0 })
  })

  it('名單部分推播失敗（不是好友）→ 算已發，不重試轟炸 LINE API', async () => {
    pushMessage.mockRejectedValueOnce(new Error('not a friend'))
    const { db, state } = makeDb(['U1'])
    const tally = await dailyBacklogDigest(db)

    expect(state[WS]).toBe(TODAY)
    expect(tally).toMatchObject({ workspacesNotified: 1 })
  })
})
