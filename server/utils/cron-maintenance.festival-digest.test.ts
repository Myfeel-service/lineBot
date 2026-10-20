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
vi.mock('./conversation-stats-rollup', async (importOriginal) => ({
  loadDayStats,
  mergeDays: (await importOriginal<typeof import('./conversation-stats-rollup')>()).mergeDays,
}))

// `C-357`：方案能不能發推播（免費＝'none'）。預設付費方案，個別測試改
const { workspaceBroadcastTier } = vi.hoisted(() => ({ workspaceBroadcastTier: vi.fn(async (): Promise<string | null> => 'advanced') }))
vi.mock('./broadcast-plan-gate', async orig => ({ ...(await orig<object>()), workspaceBroadcastTier }))

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
  /** `D-122`：卡片上按了「這次不做」的那幾檔（marketingCalendarSkips/{WS}.skips） */
  skips?: Record<string, number>
  /** `D-122`：店家自己的檔期（marketingCalendarEvents/{WS}.events） */
  ownEvents?: Record<string, { name: string, date: string, createdAt: number }>
  /** `D-122`：這個帳號的推播（卡片「已排程…」與提醒都從這裡判斷） */
  broadcasts?: Record<string, unknown>[]
}

function makeDb(opts: Options = {}) {
  const { pendingUserIds = [], festivalState = {}, workspaceIds = [WS], skips, ownEvents, broadcasts = [] } = opts
  /** 每個集合被讀了幾次（驗「沒有要講的日子不花讀取」） */
  const reads: Record<string, number> = {}

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
  /** 一個帳號一份文件的那種集合（只有 WS 有資料） */
  const perWorkspaceDoc = (name: string, field: string, value: unknown) => ({
    doc: (id: string) => ({
      get: async () => {
        reads[name] = (reads[name] ?? 0) + 1
        const has = id === WS && value !== undefined
        return { exists: has, data: () => (has ? { [field]: value } : undefined) }
      },
    }),
  })
  const db = {
    collection(name: string) {
      if (name === 'cronState') return { doc: (id: string) => refs[id] ?? docRef(id, {}) }
      if (name === 'marketingCalendarSkips') return perWorkspaceDoc(name, 'skips', skips)
      if (name === 'marketingCalendarEvents') return perWorkspaceDoc(name, 'events', ownEvents)
      if (name === 'broadcasts') {
        // ⚠️ 摘要的異常探針本來就會查推播；「檔期那一趟掃描」認它的 select（帶 festivalId 那一支）
        const q = query(broadcasts.map((b, i) => ({ id: String(b.id ?? `b${i}`), data: () => b })))
        q.select = (...fields: string[]) => {
          if (fields.includes('festivalId')) reads.calendarScan = (reads.calendarScan ?? 0) + 1
          return q
        }
        return q
      }
      if (name === 'workspaces') {
        workspaceScans++
        return query(workspaceIds.map(id => ({ id, data: () => ({}) })))
      }
      if (name === 'users') {
        return { doc: () => ({ get: async () => ({ data: () => ({ displayName: '某客人' }) }) }) }
      }
      if (name !== 'conversationSessions') reads[name] = (reads[name] ?? 0) + 1
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

  return { db, backlogState, festState, workspaceScans: () => workspaceScans, reads }
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

  it('`D-122`：沒有一檔要講的日子，只讀「自己的檔期」那一份，不讀收起來的、不掃推播', async () => {
    vi.setSystemTime(NOW_NO_FESTIVAL)
    const { db, reads } = makeDb()
    await dailyBacklogDigest(db)

    expect(reads.marketingCalendarEvents).toBe(1)
    expect(reads.marketingCalendarSkips).toBeUndefined()
    expect(reads.calendarScan).toBeUndefined()
  })

  it('對照組：有一檔要講的日子，收起來的與推播都要讀（證明上面那條量得到）', async () => {
    const { db, reads } = makeDb() // NOW＝中秋前 7 天
    await dailyBacklogDigest(db)

    expect(reads.marketingCalendarSkips).toBe(1)
    expect(reads.calendarScan).toBe(1)
  })
})

/**
 * `D-122`①（2026-10-19）：早上的提醒跟首頁卡片同步。
 * 以前只記得「講過幾次」：卡片上收起來的照樣提醒、排好推播的 3 天前照樣叫他「今天就去排」。
 */
describe('提醒跟卡片同步（D-122①）', () => {
  /** 台北 2026-10-15（四）11:00＝重陽（10/18）前 3 天 */
  const NOW_NINTH_3 = Date.UTC(2026, 9, 15, 3, 0, 0)
  /** 台灣 10/16 20:00 */
  const AT_1016_2000 = Date.UTC(2026, 9, 16, 12)
  const ninthSent = { [WS]: { 'doubleninth-2026': 7 } }
  const bcDoc = (over: Record<string, unknown> = {}) => ({
    id: 'bc-ninth', workspaceId: WS, name: '重陽敬老早鳥', status: 'scheduled',
    scheduleAt: { _seconds: AT_1016_2000 / 1000 }, createdAt: { _seconds: Date.UTC(2026, 9, 10) / 1000 }, ...over,
  })

  beforeEach(() => vi.setSystemTime(NOW_NINTH_3))

  it('已排程：講排在哪天（示意頁那一句），⛔ 不再叫他今天去排', async () => {
    const { db, festState } = makeDb({ festivalState: ninthSent, broadcasts: [bcDoc()] })
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('🎉 再過 3 天就是重陽節。「重陽敬老早鳥」排在 10/16 20:00 了，記得確認庫存和出貨來不來得及。')
    expect(sentText()).not.toContain('建議今天就到後台')
    expect(festState[WS]).toEqual({ 'doubleninth-2026': 3 })
  })

  it('還是草稿：照舊提醒去排，並講是哪一則還沒排', async () => {
    const { db } = makeDb({ festivalState: ninthSent, broadcasts: [bcDoc({ status: 'draft', scheduleAt: null })] })
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('🎉 再過 3 天就是重陽節。你有一則草稿「重陽敬老早鳥」還沒排，建議今天就到後台「推播」排進去')
  })

  it('還沒有推播（對照組）：跟以前同一句', async () => {
    const { db } = makeDb({ festivalState: ninthSent })
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('🎉 再過 3 天就是重陽節。建議今天就到後台「推播」把節慶訊息排進去')
  })

  it('⛔ 免費方案（不能發推播，`C-357`）：只提醒檔期快到了，不叫他去排推播', async () => {
    workspaceBroadcastTier.mockResolvedValueOnce('none')
    const { db, festState } = makeDb({ festivalState: ninthSent })
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('🎉 再過 3 天就是重陽節。記得確認庫存和出貨來不來得及。')
    expect(sentText()).not.toContain('推播')
    expect(festState[WS]).toEqual({ 'doubleninth-2026': 3 }) // 照樣記里程碑
  })

  it('免費方案有一則（降級前留下的）草稿：也不講「還沒排」——他現在送不出去', async () => {
    workspaceBroadcastTier.mockResolvedValueOnce('none')
    const { db } = makeDb({ festivalState: ninthSent, broadcasts: [bcDoc({ status: 'draft', scheduleAt: null })] })
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('🎉 再過 3 天就是重陽節。記得確認庫存和出貨來不來得及。')
    expect(sentText()).not.toContain('還沒排')
  })

  it('方案讀不到：照舊講（fail-open，同推播頁與送出端）', async () => {
    workspaceBroadcastTier.mockRejectedValueOnce(new Error('firestore down'))
    const { db } = makeDb({ festivalState: ninthSent })
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('建議今天就到後台「推播」把節慶訊息排進去')
  })

  it('⛔ 綁在別檔的推播不算這一檔（跟卡片同一條歸屬規則）', async () => {
    const { db } = makeDb({ festivalState: ninthSent, broadcasts: [bcDoc({ name: '重陽雙11早鳥', festivalId: 'double11-2026' })] })
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('建議今天就到後台「推播」把節慶訊息排進去')
  })

  it('卡片上按了「這次不做」：不提醒它，也不記里程碑（還原之後還講得到）', async () => {
    const { db, festState } = makeDb({ festivalState: ninthSent, skips: { 'doubleninth-2026': 1 } })
    await dailyBacklogDigest(db)

    expect(pushMessage).toHaveBeenCalledTimes(1) // 摘要照發
    expect(sentText()).not.toContain('重陽')
    expect(sentText()).not.toContain('🎉')
    expect(festState[WS]).toEqual({ 'doubleninth-2026': 7 })
  })

  it('已經排好的那一檔，7 天那一句不花客製的 LLM（反正不講切角）', async () => {
    vi.setSystemTime(NOW) // 中秋前 7 天
    const scheduled = { id: 'bc-mid', workspaceId: WS, name: '中秋禮盒早鳥', status: 'scheduled', scheduleAt: { _seconds: Date.UTC(2026, 8, 23, 12) / 1000 } }
    const a = makeDb({ broadcasts: [scheduled] })
    await dailyBacklogDigest(a.db)
    expect(sentText()).toContain('🎉 再過 7 天就是中秋節（09/25）。「中秋禮盒早鳥」排在 09/23 20:00 了')
    expect(a.reads.storeProfiles).toBeUndefined()

    // 對照組：還沒排的照舊去讀輪廓客製（證明上面那條量得到）
    pushMessage.mockClear()
    const b = makeDb()
    await dailyBacklogDigest(b.db)
    expect(b.reads.storeProfiles).toBe(1)
  })
})

describe('店家自己的檔期也提醒（D-122②）', () => {
  const OWN = 'own-anniv-0000-0001'
  /** 台北 2026-09-01：節日表上最近的中秋還有 24 天（節日閘門關著） */
  const ownEvents = { [OWN]: { name: '週年慶', date: '2026-09-08', createdAt: 1 } }

  it('節日表沒有一檔快到、自己的檔期 7 天後 → 照樣提醒，並記里程碑', async () => {
    vi.setSystemTime(NOW_NO_FESTIVAL)
    const { db, festState } = makeDb({ ownEvents })
    const tally = await dailyBacklogDigest(db)

    expect(sentText()).toContain('🎉 再過 7 天就是週年慶（09/08）。建議這幾天先把檔期優惠、贈品和圖文素材準備好。')
    expect(festState[WS]).toEqual({ [OWN]: 7 })
    expect(tally).toMatchObject({ festivalReminders: 1 })
  })

  it('⛔ 記別的節日時不可以把自己的檔期當成「表上沒有」清掉（不然隔天同一句又講一次）', async () => {
    // 中秋前 7 天；自己的檔期 9/23（5 天後）已經講過 7 天那次、還沒到 3 天那次
    const own = { [OWN]: { name: '週年慶', date: '2026-09-23', createdAt: 1 } }
    const { db, festState } = makeDb({ ownEvents: own, festivalState: { [WS]: { [OWN]: 7, 'own-deleted-0000': 3 } } })
    await dailyBacklogDigest(db)

    expect(festState[WS]).toEqual({ [OWN]: 7, 'midautumn-2026': 7 }) // 刪掉的那一檔照樣清
  })
})
