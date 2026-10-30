/**
 * 每日客服摘要：一天一則的防重複（2026-08-07）＋ 2026-09-17 改版（`D-81`）。
 *
 * 原本的判重是「開頭讀一次整份 cronState、整批跑完才在最後寫回」，中間夾著設定讀取與
 * 推播——只要有第二個排程執行者（Cloud Scheduler 逾時重試、Lambda 併發、本機 dev 的
 * scheduledTasks）就會發出兩份一樣的摘要。改成逐 workspace 用交易認領當天名額。
 *
 * 要守住的行為：
 *  - 今天已認領 → 不再發
 *  - 認領要排在「時段還沒到 / 通知關閉 / 休假日」的判斷之後（否則會白白吃掉當天名額）
 *  - 推播丟例外 → 拆掉當天名額，下一輪重來
 *  - **每天都發**（2026-09-17 拍板選項 B）：沒事的日子發一行短版
 *  - **逐工作區查**：⛔原本七個查詢是「不分工作區撈全站前 200 筆」，別家的數字會算進來
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
  wasQuotaExhaustedNotified: vi.fn(async () => false),
}))

const { pushMessage } = vi.hoisted(() => ({ pushMessage: vi.fn(async (..._a: any[]) => ({})) }))
vi.mock('./line', () => ({ pushMessage }))

// 摘要尾巴的「黃級異常」行（D-36①）吃這支探針彙總;預設回空＝既有案例的訊息內容不變
const { collectWorkspaceAlerts } = vi.hoisted(() => ({ collectWorkspaceAlerts: vi.fn(async () => [] as any[]) }))
const { countRecentUnboundRenewals } = vi.hoisted(() => ({ countRecentUnboundRenewals: vi.fn(async () => 0) }))
vi.mock('./workspace-alerts', () => ({ collectWorkspaceAlerts, countRecentUnboundRenewals }))

const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))

// 昨天的成績走日結（統計頁同一支算式）——這裡只驗「有沒有被放進訊息」，算式本身在
// conversation-stats-rollup 自己的測試守
const { loadDayStats } = vi.hoisted(() => ({ loadDayStats: vi.fn() }))
// 好幾天加總（`D-137`①）用真的 mergeDays：那是統計頁同一支加總，假的就驗不出加錯
vi.mock('./conversation-stats-rollup', async (importOriginal) => ({
  loadDayStats,
  mergeDays: (await importOriginal<typeof import('./conversation-stats-rollup')>()).mergeDays,
}))

// 週報只驗「哪天附、窗口錨在哪個週一」；內容由 weekly-insights 自己的測試守。預設沒東西可講
const { buildWeeklyInsights } = vi.hoisted(() => ({ buildWeeklyInsights: vi.fn(async (..._a: any[]) => null as string[] | null) }))
vi.mock('./weekly-insights', () => ({ buildWeeklyInsights }))

/** 每一個 where 條件（欄位、值）——驗「到期下架的知識看多久以前」用 */
const whereLog: Array<[string, unknown]> = []

import { dailyBacklogDigest } from './cron-maintenance'

const WS = 'WS'
// 台北 2026-08-07 11:00（UTC 03:00）→ digestHour 10 已到、digestHour 12 還沒到
const NOW = Date.UTC(2026, 7, 7, 3, 0, 0)
const TODAY = '2026-08-07'
const YESTERDAY = '2026-08-06'

/** 昨天的日結：預設 8 場、AI 全包，讓「順利的一天」有數字可講 */
function dayStats(over: Record<string, unknown> = {}) {
  return {
    date: YESTERDAY,
    total: 8,
    bot: 0,
    ai: 8,
    human: 0,
    unhandled: 0,
    handoff: 0,
    closed: 8,
    aiEscalated: 0,
    botEscalated: 0,
    closedHandled: 8,
    newFriends: 2,
    unhandledSamples: [],
    handoffWaits: [],
    ...over,
  }
}

function applyPatch(data: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if ((v as any)?.__op === 'del') delete data[k]
    else data[k] = v
  }
}

/**
 * @param pendingUserIds 掛在「等待真人」的客人（每位都等了 90 分鐘）
 * @param initialState   cronState/backlog-digest 的起始內容（快照與即時資料都有）
 * @param liveOnlyState  **只有交易讀得到**的內容 —— 模擬「掃描之後、認領之前，
 *                       另一個執行者搶先寫入」。快照刻意看不到，跟現場一樣。
 * @param counts         各類待辦的件數（走 count 聚合；`null`＝這一類查詢會掛掉）
 * @param workspaces     這個 DB 裡有哪些工作區（每天都發＝對象是全部工作區）
 */
function makeDb(
  pendingUserIds: string[],
  initialState: Record<string, string> = {},
  liveOnlyState: Record<string, string> = {},
  counts: Partial<Record<'knowledgeSources' | 'knowledgeChunks' | 'knowledgeSuggestions' | 'userTagSuggestions', number | null>> = {},
  workspaces: string[] = [WS],
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

  /** 只有 WS 這一家有等待真人的客人；別家問到的一律是空的（逐工作區查的重點） */
  const sessionDocs = pendingUserIds.map((uid, i) => ({
    id: `s${i}`,
    data: () => ({
      workspaceId: WS,
      userId: uid,
      status: 'pending_human',
      // 相對於「現在」，這樣改了假時鐘的案例（休假日、20:00 收摘要）也對得上
      handoffRequestedAt: { toMillis: () => Date.now() - 90 * 60_000 },
    }),
  }))

  /** 一個假查詢：where 一路串下去，get 給 docs，count 給件數（null＝這一類會掛） */
  const query = (docs: unknown[], count: number | null = docs.length, ws = '') => {
    const q: any = {
      __ws: ws,
      where: (field: string, _op: string, value: unknown) => {
        whereLog.push([field, value])
        if (field === 'workspaceId') return query(docs, count, String(value))
        // 別家工作區一律查到空的
        if (q.__ws && q.__ws !== WS) return query([], 0, q.__ws)
        if (field === 'status' && value === 'human_handling') return query([], 0, q.__ws)
        return query(docs, count, q.__ws)
      },
      select: () => q,
      limit: () => q,
      get: async () => ({ size: docs.length, docs, empty: !docs.length }),
      count: () => ({
        get: async () => {
          if (count === null) throw new Error('missing index')
          return { data: () => ({ count }) }
        },
      }),
    }
    return q
  }

  const wsDocs = workspaces.map(id => ({ id, data: () => ({ id }) }))

  const db = {
    collection(name: string) {
      if (name === 'cronState') return { doc: () => stateRef }
      if (name === 'workspaces') return query(wsDocs, wsDocs.length)
      if (name === 'users') {
        return { doc: (id: string) => ({ get: async () => ({ data: () => ({ displayName: `客人${String(id).slice(0, 2)}` }) }) }) }
      }
      if (name === 'conversationSessions') return query(sessionDocs)
      // ⛔ 不可以寫 `?? 0`：null 在這裡的意思是「這一類查詢會掛掉」，不是 0 件
      if (name in counts) return query([], counts[name as keyof typeof counts] as number | null)
      return query([], 0)
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

/** 第一個收件人收到的那則訊息 */
const sentText = () => (pushMessage.mock.calls[0]![1] as any)[0].text as string

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  pushMessage.mockClear()
  pushMessage.mockResolvedValue({})
  getAiSettings.mockReset()
  getAiSettings.mockResolvedValue(settings())
  collectWorkspaceAlerts.mockClear()
  collectWorkspaceAlerts.mockResolvedValue([])
  countRecentUnboundRenewals.mockReset()
  countRecentUnboundRenewals.mockResolvedValue(0)
  loadDayStats.mockReset()
  loadDayStats.mockImplementation(async (_db: any, _ws: string, keys: string[]) => ({
    days: new Map(keys.map(k => [k, dayStats({ date: k })])),
    liveDays: [],
    rollupDays: keys,
  }))
  buildWeeklyInsights.mockClear()
  buildWeeklyInsights.mockResolvedValue(null)
  whereLog.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('dailyBacklogDigest 一天一則', () => {
  it('有積壓且時段已到 → 發一則並記下今天', async () => {
    const { db, state } = makeDb(['U1', 'U2'])
    const tally = await dailyBacklogDigest(db)

    expect(pushMessage).toHaveBeenCalledTimes(2) // 兩個收件人 × 一則
    expect(sentText()).toContain('現在有 2 位客人在等真人')
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

  it('沒有人勾「早上的摘要」/ 名單為空 → 不發也不吃名額', async () => {
    // `D-143`：名單上有人，但兩位都把摘要取消了（讀出來的設定已經過 normalize，enabled 不會跟名單打架）
    getAiSettings.mockResolvedValue(settings(10, { optOut: { Sa: ['digest'], Sb: ['digest', 'crit'] } }))
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

  it('`D-143`：只傳給勾了「早上的摘要」的人', async () => {
    getAiSettings.mockResolvedValue(settings(10, { optOut: { Sb: ['digest'] } }))
    const { db } = makeDb(['U1'])
    await dailyBacklogDigest(db)
    expect(pushMessage).toHaveBeenCalledTimes(1)
    expect(pushMessage.mock.calls[0]![0]).toBe('Sa')
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

/**
 * 每天都發（2026-09-17 拍板選項 B）。
 *
 * 原本「沒事就不發」：商家收不到訊息時分不出是「昨天很順」還是「通知壞掉了」，
 * 而通知名單沒設好會讓轉真人提醒、摘要、紅色異常**全部靜音**。
 */
describe('dailyBacklogDigest 順利的一天也要發', () => {
  it('完全沒有待辦 → 照發，而且只有一行（含昨天的成績）', async () => {
    const { db, state } = makeDb([])
    const tally = await dailyBacklogDigest(db)

    expect(tally).toMatchObject({ workspacesNotified: 1 })
    expect(state[WS]).toBe(TODAY)
    const lines = sentText().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('昨天 8 場對話，AI 全部自己搞定，沒有人在等。')
    expect(lines[0]).toContain('新朋友 +2 位。')
  })

  it('昨天的數字取日結（跟統計頁同一支算式），查的是昨天那一天', async () => {
    const { db } = makeDb([])
    await dailyBacklogDigest(db)

    expect(loadDayStats).toHaveBeenCalledWith(expect.anything(), WS, [YESTERDAY])
  })

  it('昨天的數字查不到 → 照實講，⛔不可以講成 0 場', async () => {
    loadDayStats.mockRejectedValue(new Error('boom'))
    const { db } = makeDb(['U1'])
    await dailyBacklogDigest(db)

    const text = sentText()
    expect(text).toContain('昨天的數字這次查不到')
    expect(text).not.toContain('昨天 0 場')
  })

  it('AI 沒有全包時，三個數字加起來等於總場數', async () => {
    loadDayStats.mockResolvedValue({
      // 10 場：AI 首接 8（其中 2 場後來轉真人）、真人首接 1、沒人回 1
      days: new Map([[YESTERDAY, dayStats({ total: 10, ai: 8, aiEscalated: 2, human: 1, unhandled: 1, newFriends: 0 })]]),
      liveDays: [], rollupDays: [YESTERDAY],
    })
    const { db } = makeDb([])
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('昨天 10 場對話，AI 自己搞定 6 場、你出手 3 場、1 場一整天沒人回')
  })
})

/**
 * 逐工作區查（2026-09-17 修）。
 *
 * ⛔ 原本七個來源查詢全是「不分工作區撈全站前 200 筆」：租戶一多就會有帳號的數字
 * 被別家吃掉、甚至整家從摘要裡消失，而訊息照發、看起來完全正常。
 */
describe('dailyBacklogDigest 逐工作區查', () => {
  it('別家的等待真人不會算到自己頭上', async () => {
    const { db } = makeDb(['U1', 'U2'], {}, {}, {}, [WS, 'OTHER'])
    const tally = await dailyBacklogDigest(db)

    expect(tally).toMatchObject({ workspacesNotified: 2 })
    const texts = pushMessage.mock.calls.map(c => (c[1] as any)[0].text as string)
    const otherTexts = pushMessage.mock.calls.filter(c => c[2] === 'OTHER').map(c => (c[1] as any)[0].text as string)
    expect(texts.some(t => t.includes('現在有 2 位客人在等真人'))).toBe(true)
    expect(otherTexts).not.toHaveLength(0)
    expect(otherTexts.every(t => !t.includes('在等真人'))).toBe(true)
  })

  it('某一類查不到（缺索引）→ 那一類講「查不到」，其他照常', async () => {
    const { db } = makeDb([], {}, {}, { knowledgeSources: null })
    await dailyBacklogDigest(db)

    const text = sentText()
    expect(text).toContain('這次查不到')
    expect(text).toContain('昨天 8 場對話')
  })
})

describe('dailyBacklogDigest 貼標建議待審（D-43①）', () => {
  it('有客人的標籤建議待審 → 摘要多一行、落點指到「好友」頁', async () => {
    const { db } = makeDb(['U1'], {}, {}, { userTagSuggestions: 2 })
    await dailyBacklogDigest(db)

    const text = sentText()
    expect(text).toContain('2 位客人的標籤建議等你決定')
    expect(text).toContain('「好友」')
  })

  it('沒有待審 → 不多這一行', async () => {
    const { db } = makeDb(['U1'])
    await dailyBacklogDigest(db)

    expect(sentText()).not.toContain('標籤建議')
  })
})

describe('dailyBacklogDigest 黃級異常搭便車', () => {
  it('摘要要發時尾巴加一行,照允許清單的優先序點名最重要那件', async () => {
    collectWorkspaceAlerts.mockResolvedValue([
      { id: 'scriptUnreachable', state: 'active' },
      { id: 'broadcastFailed', state: 'active' }, // 允許清單排第一=最重要
      { id: 'humanBacklog', state: 'active' }, // 摘要本文已講,不在允許清單
      { id: 'knowledgeDetectStalled', state: 'clear' }, // 沒發生
    ])
    const { db } = makeDb(['U1'])
    await dailyBacklogDigest(db)

    const text = sentText()
    expect(text).toContain('另有 2 件建議處理的事')
    expect(text).toContain('最重要的是「有推播沒有送出去」')
    expect(text).not.toContain('永遠不會被啟動') // 只點名最重要那件,不把異常面板搬進 LINE
  })

  it('推播記了時間還沒排上（`C-433`）→ 早上這一則點名：記了時間就離開後台的人，只有這裡會在時間到之前叫他', async () => {
    collectWorkspaceAlerts.mockResolvedValue([{ id: 'broadcastNotScheduled', state: 'active' }])
    const { db } = makeDb(['U1'])
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('最重要的是「有推播還沒排上，不會自動送」')
  })

  it('綁卡沒成那顆不在營運探針組,單獨查、而且排在允許清單第一（錢的事最重要）', async () => {
    countRecentUnboundRenewals.mockResolvedValue(1)
    collectWorkspaceAlerts.mockResolvedValue([{ id: 'broadcastFailed', state: 'active' }])
    const { db } = makeDb(['U1'])
    await dailyBacklogDigest(db)

    const text = sentText()
    expect(text).toContain('另有 2 件建議處理的事')
    expect(text).toContain('最重要的是「下期不會自動扣款（卡沒綁成）」')
  })

  it('綁卡查詢掛掉 → 當沒有,摘要與其他黃級照常（⛔不准拖垮摘要本體）', async () => {
    countRecentUnboundRenewals.mockRejectedValue(new Error('boom'))
    collectWorkspaceAlerts.mockResolvedValue([{ id: 'broadcastFailed', state: 'active' }])
    const { db } = makeDb(['U1'])
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('最重要的是「有推播沒有送出去」')
  })

  it('探針掛掉 → 摘要本體照發,只是沒有那一行', async () => {
    collectWorkspaceAlerts.mockRejectedValue(new Error('boom'))
    const { db } = makeDb(['U1'])
    const tally = await dailyBacklogDigest(db)

    expect(tally).toMatchObject({ workspacesNotified: 1 })
    const text = sentText()
    expect(text).toContain('現在有 1 位客人在等真人')
    expect(text).not.toContain('建議處理的事')
  })
})

/**
 * 假日不吵人（2026-08-08 老闆回報「假日還是會收到每日推播」）。
 *
 * 摘要是照著資料上的標記每天重喊一次,所以休假日整天跳過不會漏掉任何一條——
 * 上班日那則會把週末累積的全部講完。
 */
describe('dailyBacklogDigest 休假日', () => {
  const SAT = Date.UTC(2026, 7, 8, 3, 0, 0) // 台北 2026-08-08(六) 11:00
  /** 服務時間 09–18、週六日休息；digestHour 預設 10（台北 11 點時已到）。 */
  const hours = (extra: Record<string, unknown> = {}, digestHour = 10) => ({
    ...settings(digestHour),
    serviceHours: { enabled: true, start: '09:00', end: '18:00', weekendOff: true, dndReply: '', ...extra },
  })

  beforeEach(() => {
    vi.setSystemTime(SAT)
  })

  it('服務時間有開 + 週六日休息 → 週六不發，也不吃掉當天名額', async () => {
    getAiSettings.mockResolvedValue(hours({}))
    const { db, state } = makeDb(['U1'])
    const tally = await dailyBacklogDigest(db)

    expect(pushMessage).not.toHaveBeenCalled()
    expect(state[WS]).toBeUndefined()
    expect(tally).toMatchObject({ workspacesNotified: 0 })
  })

  it('週末照常服務 → 週六照發（沒勾休息就不該幫商家決定）', async () => {
    getAiSettings.mockResolvedValue(hours({ weekendOff: false }))
    const { db } = makeDb(['U1'])

    expect(await dailyBacklogDigest(db)).toMatchObject({ workspacesNotified: 1 })
  })

  it('沒啟用服務時間 → 週六照發（維持原行為）', async () => {
    getAiSettings.mockResolvedValue(settings(10)) // serviceHours.enabled = false
    const { db } = makeDb(['U1'])

    expect(await dailyBacklogDigest(db)).toMatchObject({ workspacesNotified: 1 })
  })

  it('平日的摘要時段落在服務時間之外（09–18 上班、20:00 收摘要）→ 照發', async () => {
    // 拿整個「勿擾時段」去擋的話這種商家會永遠收不到摘要，所以只擋休假日
    vi.setSystemTime(Date.UTC(2026, 7, 10, 12, 0, 0)) // 台北 2026-08-10(一) 20:00
    getAiSettings.mockResolvedValue(hours({}, 20))
    const { db } = makeDb(['U1'])

    expect(await dailyBacklogDigest(db)).toMatchObject({ workspacesNotified: 1 })
  })

  it('下班時段進來的客人不加紅點（天天紅字＝狼來了）', async () => {
    // 週一 20:00 發、服務時間 09–18 → 90 分鐘前（18:30）轉真人的那位算下班時段
    vi.setSystemTime(Date.UTC(2026, 7, 10, 12, 0, 0))
    getAiSettings.mockResolvedValue(hours({}, 20))
    const { db } = makeDb(['U1'])
    await dailyBacklogDigest(db)

    const text = sentText()
    expect(text).toContain('都是下班時段進來的')
    expect(text).not.toContain('🔴')
  })
})

/**
 * 回來那天把上一則之後的每一天講完（`D-137`，2026-10-21）。
 *
 * 原本週一那則只講「昨天」＝週日，週五、週六的成績從來沒有被講過（MYFEEL 9/17～10/19
 * 854 場有 200 場落在這兩天）；國定假日系統又不認得，連假回來只講最後一天。
 */
describe('dailyBacklogDigest 休假日之後的第一則', () => {
  /** MYFEEL 的設定：舊資料沒有 holidayOff ＝ 跟週末一樣休 */
  const myfeel = (extra: Record<string, unknown> = {}) => ({
    ...settings(10),
    serviceHours: { enabled: true, start: '10:00', end: '19:00', weekendOff: true, dndReply: '', ...extra },
  })
  const MON = Date.UTC(2026, 9, 19, 3, 0, 0) // 台北 2026-10-19(一) 11:00
  const TUE_AFTER_HOLIDAY = Date.UTC(2026, 9, 27, 3, 0, 0) // 台北 2026-10-27(二) 11:00，前一天光復節補假

  it('週一 → 查週五到週日三天，一句講完（每天 8 場 → 24 場）', async () => {
    vi.setSystemTime(MON)
    getAiSettings.mockResolvedValue(myfeel())
    const { db } = makeDb([])
    await dailyBacklogDigest(db)

    expect(loadDayStats).toHaveBeenCalledWith(expect.anything(), WS, ['2026-10-16', '2026-10-17', '2026-10-18'])
    expect(sentText()).toContain('10/16（五）到 10/18（日）這 3 天共 24 場對話，AI 全部自己搞定')
    expect(sentText()).toContain('新朋友 +6 位。')
  })

  it('週一 → 到期下架的知識看 72 小時（週五這時候之後），不是 24 小時', async () => {
    vi.setSystemTime(MON)
    getAiSettings.mockResolvedValue(myfeel())
    const { db } = makeDb([])
    await dailyBacklogDigest(db)

    const expired = whereLog.filter(([f]) => f === 'expiredAt').map(([, v]) => (v as any).__ts)
    expect(expired).toEqual([MON - 72 * 3600_000])
  })

  it('週一 → 附本週顧客觀察，窗口錨在這個週一', async () => {
    vi.setSystemTime(MON)
    getAiSettings.mockResolvedValue(myfeel())
    const { db } = makeDb([])
    await dailyBacklogDigest(db)

    expect(buildWeeklyInsights).toHaveBeenCalledWith(expect.anything(), WS, '2026-10-19', { profileRefresh: true })
  })

  it('國定假日（10/26 一）整天不發，也不吃掉當天名額', async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 26, 3, 0, 0))
    getAiSettings.mockResolvedValue(myfeel())
    const { db, state } = makeDb(['U1'])
    await dailyBacklogDigest(db)

    expect(pushMessage).not.toHaveBeenCalled()
    expect(state[WS]).toBeUndefined()
  })

  it('連假回來（10/27 二）→ 講 10/23 到 10/26 四天；週報改在今天附、窗口照樣錨在週一 10/26', async () => {
    vi.setSystemTime(TUE_AFTER_HOLIDAY)
    getAiSettings.mockResolvedValue(myfeel())
    const { db } = makeDb([])
    await dailyBacklogDigest(db)

    expect(loadDayStats).toHaveBeenCalledWith(expect.anything(), WS, ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'])
    expect(sentText()).toContain('10/23（五）到 10/26（一）這 4 天共 32 場對話')
    expect(buildWeeklyInsights).toHaveBeenCalledWith(expect.anything(), WS, '2026-10-26', { profileRefresh: true })
  })

  it('整週放假（2026 春節 2/16～2/20）→ 回來那天兩週的週報都附、由舊到新；輪廓兩題只跟最新那週（`C-362`）', async () => {
    vi.setSystemTime(Date.UTC(2026, 1, 23, 3, 0, 0)) // 台北 2026-02-23(一) 11:00
    getAiSettings.mockResolvedValue(myfeel())
    buildWeeklyInsights.mockImplementation(async (_db: any, _ws: string, monday: string) => [`📈 本週顧客觀察（${monday}）`])
    const { db } = makeDb([])
    await dailyBacklogDigest(db)

    expect(buildWeeklyInsights.mock.calls.map(c => [c[2], c[3]])).toEqual([
      ['2026-02-16', { profileRefresh: false }],
      ['2026-02-23', { profileRefresh: true }],
    ])
    const lines = sentText().split('\n')
    const a = lines.indexOf('📈 本週顧客觀察（2026-02-16）')
    const b = lines.indexOf('📈 本週顧客觀察（2026-02-23）')
    expect(a).toBeGreaterThan(0)
    expect(b).toBe(a + 2) // 兩段之間空一行
    expect(lines[a + 1]).toBe('')
  })

  it('好幾天的沒人回：同一位客人週五、週六各一場 → 只點名一次，「位」數人不數場（`C-362`）', async () => {
    vi.setSystemTime(MON)
    getAiSettings.mockResolvedValue(myfeel())
    const sample = (userId: string, day: number) => ({ userId, openedAtMs: Date.UTC(2026, 9, day, 3) })
    loadDayStats.mockResolvedValue({
      days: new Map([
        ['2026-10-16', dayStats({ ai: 7, unhandled: 1, unhandledSamples: [sample('U1', 16)] })],
        ['2026-10-17', dayStats({ ai: 7, unhandled: 1, unhandledSamples: [sample('U1', 17)] })],
        ['2026-10-18', dayStats({ ai: 7, unhandled: 1, unhandledSamples: [sample('U2', 18)] })],
      ]),
      liveDays: [], rollupDays: [],
    })
    const { db } = makeDb(['U9'])
    const collection = db.collection.bind(db)
    db.collection = (name: string) => name === 'users'
      ? { doc: (id: string) => ({ get: async () => ({ data: () => ({ displayName: `客人${id.split('_')[1]}` }) }) }) }
      : collection(name)
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('3 場沒人回。')
    expect(sentText()).toContain('沒人回的是客人U1與客人U2。')
  })

  it('某天沒人回超過 3 場（名單沒存全）→ 數不出幾位就不硬給數字', async () => {
    vi.setSystemTime(MON)
    getAiSettings.mockResolvedValue(myfeel())
    const sample = (userId: string) => ({ userId, openedAtMs: Date.UTC(2026, 9, 16, 3) })
    loadDayStats.mockImplementation(async (_db: any, _ws: string, keys: string[]) => ({
      days: new Map(keys.map(k => [k, k === '2026-10-16'
        ? dayStats({ date: k, ai: 3, unhandled: 5, unhandledSamples: [sample('U1'), sample('U2'), sample('U3')] })
        : dayStats({ date: k })])),
      liveDays: [], rollupDays: [],
    }))
    // 有一位在等才是完整版（順利的一天那一行版不點名）
    const { db } = makeDb(['U9'])
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('5 場沒人回。')
    expect(sentText()).toMatch(/沒人回的是.+等人。/)
    expect(sentText()).not.toContain('等 5 位')
  })

  it('國定假日照常上班的店 → 10/27 只講 10/26，週報週一就附過了', async () => {
    vi.setSystemTime(TUE_AFTER_HOLIDAY)
    getAiSettings.mockResolvedValue(myfeel({ holidayOff: false }))
    const { db } = makeDb([])
    await dailyBacklogDigest(db)

    expect(loadDayStats).toHaveBeenCalledWith(expect.anything(), WS, ['2026-10-26'])
    expect(sentText()).toContain('昨天 8 場對話')
    expect(buildWeeklyInsights).not.toHaveBeenCalled()
  })

  it('三天裡缺一天 → 整段講「查不到」，⛔ 不拿兩天的數字當三天講', async () => {
    vi.setSystemTime(MON)
    getAiSettings.mockResolvedValue(myfeel())
    loadDayStats.mockResolvedValue({
      days: new Map([['2026-10-16', dayStats()], ['2026-10-18', dayStats()]]),
      liveDays: [], rollupDays: [],
    })
    // 有一位在等才會發（成績查不到、又沒別的事可講時整則不發，下一輪重來）
    const { db } = makeDb(['U1'])
    await dailyBacklogDigest(db)

    expect(sentText()).toContain('這 3 天的數字這次查不到，後台「對話統計」看得到')
    expect(sentText()).not.toContain('16 場')
    // 明天那則只講今天，這 3 天之後不會再有一則講——⛔ 不可以說「明天會再看一次」（`C-362`）
    expect(sentText()).not.toContain('明天會再看一次')
  })
})
