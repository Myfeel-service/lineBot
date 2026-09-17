/**
 * 每日摘要裡的節慶行銷提醒（2026-08-20）。
 *
 * 判定與文案本身在 `shared/taiwan-festivals.test.ts`；這裡釘住的是**接線**：
 *  - 當天沒有任何客服／知識庫待辦，也要照發（老闆拍板；否則提醒常常無聲消失）
 *    → 這件事需要「連沒積壓的帳號都要撈出來」，而積壓聚合裡根本沒有那些帳號
 *  - 有待辦時是**同一則訊息多一段**，不另發一則（LINE 按則計費）
 *  - 商家關掉節慶提醒 → 只有節慶可講的日子整則不發，且不吃掉當天名額
 *  - 送出去才記里程碑；推播失敗不可以記（否則這個節日從此靜音）
 *  - 沒有節日進入 7 天內 → **完全不掃 workspaces**（2026-08-11 讀取費暴衝的形狀）
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
vi.mock('./conversation-session', () => ({ handBackSessionToBot: vi.fn(), closeConversationSession: vi.fn() }))
vi.mock('./webhook-dedup', () => ({ WEBHOOK_EVENT_LOCKS_COLLECTION: 'webhookEventLocks' }))
vi.mock('./ai-handoff-notify', () => ({
  notifyHandoffToStaff: vi.fn(async () => true),
  notifyOverdueHandoffBatch: vi.fn(async () => true),
}))

const { pushMessage } = vi.hoisted(() => ({ pushMessage: vi.fn(async (..._a: any[]) => ({})) }))
vi.mock('./line', () => ({ pushMessage }))

const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))

// 摘要開頭「昨天的成績」走日結（2026-09-17 `D-81`）；這裡固定給一份，
// 節慶提醒的接線才不會被昨天的數字干擾
const { loadDayStats } = vi.hoisted(() => ({ loadDayStats: vi.fn() }))
vi.mock('./conversation-stats-rollup', () => ({ loadDayStats }))

import { dailyBacklogDigest } from './cron-maintenance'

const WS = 'WS'
/** 台北 2026-09-18 11:00（UTC 03:00）＝中秋（09-25）前 7 天，digestHour 10 已過 */
const NOW = Date.UTC(2026, 8, 18, 3, 0, 0)
/** 台北 2026-09-01 11:00：離最近的節日 24 天，節慶閘門關著 */
const NOW_NO_FESTIVAL = Date.UTC(2026, 8, 1, 3, 0, 0)

function applyPatch(target: Record<string, any>, patch: Record<string, any>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v?.__op === 'del') delete target[k]
    else if (v && typeof v === 'object' && !Array.isArray(v) && v.__op === undefined) {
      // 巢狀 map 的 merge：節慶進度存成 { [ws]: { [festivalId]: 里程碑 } }
      target[k] = target[k] && typeof target[k] === 'object' ? { ...target[k] } : {}
      applyPatch(target[k], v)
    }
    else target[k] = v
  }
}

interface Options {
  /** 掛在「等待真人」的客人（讓摘要有客服待辦可講） */
  pendingUserIds?: string[]
  /** cronState/festival-digest 的起始內容 */
  festivalState?: Record<string, Record<string, number>>
  /** workspaces 集合裡有哪些帳號（節慶提醒要靠這份才撈得到沒積壓的帳號） */
  workspaceIds?: string[]
}

function makeDb(opts: Options = {}) {
  const { pendingUserIds = [], festivalState = {}, workspaceIds = [WS] } = opts

  const backlogState: Record<string, any> = {}
  const festState: Record<string, any> = structuredClone(festivalState)
  const docRef = (id: string, store: Record<string, any>) => ({
    id,
    get: async () => ({ data: () => ({ ...store }) }),
    set: async (patch: Record<string, any>) => { applyPatch(store, patch) },
  })
  const refs: Record<string, any> = {
    'backlog-digest': docRef('backlog-digest', backlogState),
    'festival-digest': docRef('festival-digest', festState),
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

  const query = (docs: unknown[]) => {
    const q: any = {
      where: () => q,
      select: () => q, // 貼標建議那條查詢有帶 select（D-43①），假 db 缺這個方法整包 Promise.all 會炸
      limit: () => q,
      get: async () => ({ size: docs.length, docs, empty: !docs.length }),
      // 待辦件數走 count 聚合（2026-09-17 改逐工作區查）
      count: () => ({ get: async () => ({ data: () => ({ count: docs.length }) }) }),
    }
    return q
  }

  let workspaceScans = 0
  const db = {
    collection(name: string) {
      if (name === 'cronState') return { doc: (id: string) => refs[id] ?? docRef(id, {}) }
      if (name === 'workspaces') {
        workspaceScans++
        return query(workspaceIds.map(id => ({ id, data: () => ({}) })))
      }
      if (name === 'users') {
        return { doc: () => ({ get: async () => ({ data: () => ({ displayName: '某客人' }) }) }) }
      }
      if (name === 'conversationSessions') {
        // 逐工作區查：先 where('workspaceId')，再 where('status')。只有 WS 有人在等
        const forWs = (ws: string) => {
          const q: any = {
            where: (_f: string, _op: string, value: string) =>
              query(ws === WS && value === 'pending_human' ? sessionDocs : []),
            limit: () => q,
            get: async () => ({ size: 0, docs: [], empty: true }),
          }
          return q
        }
        return { where: (_f: string, _op: string, value: string) => forWs(String(value)) }
      }
      return query([])
    },
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn({
        get: async () => ({ data: () => ({ ...backlogState }) }),
        set: (_ref: any, patch: Record<string, any>) => applyPatch(backlogState, patch),
      })
    },
  } as any

  return { db, backlogState, festState, workspaceScans: () => workspaceScans }
}

function settings(extra: Record<string, unknown> = {}) {
  return {
    handoffNotify: {
      enabled: true, lineUserIds: ['Sa'], mode: 'missed_only',
      slaRemindMinutes: 30, digestHour: 10, festivalTips: true, ...extra,
    },
    serviceHours: { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: '' },
  }
}

/** 這一輪推播出去的唯一一則訊息文字 */
const sentText = () => (pushMessage.mock.calls[0]![1] as any)[0].text as string

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  pushMessage.mockClear()
  pushMessage.mockResolvedValue({})
  getAiSettings.mockReset()
  getAiSettings.mockResolvedValue(settings())
  loadDayStats.mockReset()
  loadDayStats.mockImplementation(async (_db: any, _ws: string, keys: string[]) => ({
    days: new Map(keys.map(k => [k, {
      date: k, total: 8, bot: 0, ai: 8, human: 0, unhandled: 0, handoff: 0, closed: 8,
      aiEscalated: 0, botEscalated: 0, closedHandled: 8, newFriends: 0,
      unhandledSamples: [], handoffWaits: [],
    }])),
    liveDays: [], rollupDays: keys,
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('沒有其他待辦也照發（老闆拍板）', () => {
  it('零積壓 + 中秋前 7 天 → 節慶那段接在昨天的成績後面', async () => {
    const { db, festState } = makeDb() // 沒有任何 pending
    const tally = await dailyBacklogDigest(db)

    expect(pushMessage).toHaveBeenCalledTimes(1)
    const text = sentText()
    expect(text).toContain('🎉 再過 7 天就是中秋節（09/25）')
    expect(text).toContain('昨天 8 場對話')
    // ⛔ 不可以被讀成客服待辦：2026-09-17 改版後整則沒有待辦標題，
    //    節慶自成一段（原本是掛在「📋 每日客服摘要」底下才要換標題）
    expect(text).not.toContain('每日客服摘要')
    expect(text).not.toContain('今天可以處理')
    expect(festState[WS]).toEqual({ 'midautumn-2026': 7 })
    expect(tally).toMatchObject({ workspacesNotified: 1, festivalReminders: 1 })
  })

  it('積壓聚合裡沒有的帳號也收得到（靠 workspaces 清單撈）', async () => {
    // 積壓資料完全沒提到 WS2，只有 workspaces 集合裡有
    const { db } = makeDb({ workspaceIds: [WS, 'WS2'] })
    await dailyBacklogDigest(db)

    expect(pushMessage).toHaveBeenCalledTimes(2) // 兩個帳號各一則
  })
})

describe('有待辦時搭在同一則訊息裡', () => {
  it('客服摘要下面多一段節慶提醒，不另發一則', async () => {
    const { db } = makeDb({ pendingUserIds: ['U1', 'U2'] })
    const tally = await dailyBacklogDigest(db)

    expect(pushMessage).toHaveBeenCalledTimes(1) // ⛔ 一則，不是兩則
    const text = sentText()
    expect(text).toContain('現在有 2 位客人在等真人')
    expect(text).toContain('→ 後台「對話」')
    expect(text).toContain('🎉 再過 7 天就是中秋節')
    // 空行隔開，否則會被讀成第三條客服待辦
    expect(text).toContain('「對話」\n\n🎉')
    expect(tally).toMatchObject({ workspacesNotified: 1, festivalReminders: 1 })
  })
})

describe('商家把節慶提醒關掉', () => {
  it('摘要照發（2026-09-17 起每天都發），但整則不含節慶那段、也不記里程碑', async () => {
    getAiSettings.mockResolvedValue(settings({ festivalTips: false }))
    const { db, festState } = makeDb()
    const tally = await dailyBacklogDigest(db)

    expect(pushMessage).toHaveBeenCalledTimes(1)
    expect(sentText()).not.toContain('中秋')
    expect(festState[WS]).toBeUndefined() // 沒記里程碑
    expect(tally).toMatchObject({ workspacesNotified: 1, festivalReminders: 0 })
  })

  it('有客服待辦時照發，但不含節慶那段', async () => {
    getAiSettings.mockResolvedValue(settings({ festivalTips: false }))
    const { db, festState } = makeDb({ pendingUserIds: ['U1'] })
    const tally = await dailyBacklogDigest(db)

    expect(pushMessage).toHaveBeenCalledTimes(1)
    expect(sentText()).toContain('現在有 1 位客人在等真人')
    expect(sentText()).not.toContain('中秋')
    expect(festState[WS]).toBeUndefined()
    expect(tally).toMatchObject({ festivalReminders: 0 })
  })
})

describe('里程碑記帳', () => {
  it('這個里程碑講過了 → 摘要照發但不再提這個節日（同一節日不會天天喊）', async () => {
    const { db } = makeDb({ festivalState: { [WS]: { 'midautumn-2026': 7 } } })
    const tally = await dailyBacklogDigest(db)

    expect(pushMessage).toHaveBeenCalledTimes(1)
    expect(sentText()).not.toContain('中秋')
    expect(tally).toMatchObject({ workspacesNotified: 1, festivalReminders: 0 })
  })

  it('推播丟例外 → 不記里程碑，下一輪這個節日還講得到', async () => {
    // 同步丟例外（撈憑證失敗那類）才會逃出 allSettled、走到拆章那條路
    pushMessage.mockImplementation(() => { throw new Error('憑證撈不到') })
    const { db, backlogState, festState } = makeDb()
    await dailyBacklogDigest(db)

    expect(festState[WS]).toBeUndefined()
    expect(backlogState[WS]).toBeUndefined() // 當天名額也拆掉了
  })

  it('名單全掛（不是好友）→ 沿用既有設計算已發，里程碑照記不重試', async () => {
    // 這是刻意的：名單全掛是設定問題，重試只會每輪重打 LINE API（既有註解）。
    // 當天名額本來就會被吃掉，節慶里程碑跟著記才不會下一輪又算它沒講。
    pushMessage.mockRejectedValue(new Error('not a friend'))
    const { db, backlogState, festState } = makeDb()
    const tally = await dailyBacklogDigest(db)

    expect(backlogState[WS]).toBe('2026-09-18')
    expect(festState[WS]).toEqual({ 'midautumn-2026': 7 })
    expect(tally).toMatchObject({ festivalReminders: 1 })
  })

  it('送出提醒時順手清掉已經過完的節日紀錄（這份 doc 不會逐年變肥）', async () => {
    const { db, festState } = makeDb({
      festivalState: { [WS]: { 'ghost-2026': 1, 'unknown-2019': 3 } },
    })
    await dailyBacklogDigest(db)

    expect(festState[WS]).toEqual({ 'midautumn-2026': 7 }) // 中元已過、表上沒有的 id 一併清掉
  })
})

describe('沒有節日的日子不要白花讀取', () => {
  it('離節日還很遠 → 不讀節慶進度（workspaces 因為每天都要發，本來就要掃）', async () => {
    vi.setSystemTime(NOW_NO_FESTIVAL)
    const { db, festState, workspaceScans } = makeDb({ pendingUserIds: ['U1'] })
    const tally = await dailyBacklogDigest(db)

    // 節慶進度那份 doc 沒被讀（讀了的話 festState 會被帶進流程並可能被寫回）
    expect(festState).toEqual({})
    expect(workspaceScans()).toBe(1) // 每天都發＝一輪只掃這一次，不是每個工作區各掃一次
    expect(pushMessage).toHaveBeenCalledTimes(1) // 客服摘要照發
    expect(sentText()).not.toContain('🎉')
    expect(tally).toMatchObject({ festivalReminders: 0 })
  })

  it('離節日還很遠又沒有積壓 → 照發一行短版（2026-09-17 拍板選項 B）', async () => {
    vi.setSystemTime(NOW_NO_FESTIVAL)
    const { db } = makeDb()
    await dailyBacklogDigest(db)

    expect(pushMessage).toHaveBeenCalledTimes(1)
    expect(sentText().split('\n')).toHaveLength(1)
    expect(sentText()).toContain('沒有人在等')
  })
})
