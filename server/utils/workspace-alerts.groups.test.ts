/**
 * collectWorkspaceAlerts 的權限分組測試（C-88，2026-08-27）。
 *
 * 為什麼要釘住：探針放在哪一組（canOperate／canSettings）必須跟前端註冊表
 * （useWorkspaceAlerts 的 requires）對齊——放錯組的探針後端永遠不回，前端卻列得出
 * 該項，結果固定停在「這次查不到狀態」。C-88 就是 scannerStalled／tagDiscoverySuggestions
 * 被放進帳單組（canSettings），agent 角色（只有 canOperate）永遠拿不到答案。
 *
 * 另釘 handoffNotifyMissing 的判定放寬（D-36③）：通知名單擋的不只 AI 轉真人
 * （每日摘要、額度、嚴重異常推播全吃它），所以不看 AI 開關、只看有沒有接上 LINE。
 */
import { describe, it, expect, vi } from 'vitest'

// useRuntimeConfig 是 nitro 的自動注入,vitest 環境沒有——canSettings 路徑（LIFF 比對基準）會用到
vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: '' }))

const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))

const { getLineWorkspaceCredentials } = vi.hoisted(() => ({ getLineWorkspaceCredentials: vi.fn() }))
vi.mock('./line-workspace-credentials', () => ({ getLineWorkspaceCredentials }))

vi.mock('./alert-format', () => ({ cleanReason: (s: string) => s, humanizeHours: () => '' }))
vi.mock('./ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('./ai-knowledge-sources', () => ({ KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources' }))
vi.mock('./ai-knowledge-suggest', () => ({ KNOWLEDGE_SUGGESTIONS_COLLECTION: 'knowledgeSuggestions' }))
vi.mock('./ai-feedback-events', () => ({
  AI_FEEDBACK_EVENTS_COLLECTION: 'aiFeedbackEvents',
  aggregateWrongAnswerMarks: () => new Map(),
  isChunkUnfixedSinceMark: () => false,
}))
vi.mock('./ai-usage', () => ({ getQuotaAnswered: vi.fn(async () => 0) }))
vi.mock('./ai-scripts', () => ({ SCRIPTS_COLLECTION: 'aiScripts' }))
vi.mock('./broken-module-refs', () => ({ findBrokenModuleRefs: vi.fn(async () => []) }))
vi.mock('./script-health', () => ({ checkScriptHealth: vi.fn(async () => ({ unreachable: [], deadEnds: [] })) }))
vi.mock('./tag-discovery', () => ({ TAG_DISCOVERY_COLLECTION: 'tagDiscovery' }))
vi.mock('./claim-push-health', () => ({ CLAIM_PUSH_MARK_ALERT_WINDOW_MS: 1, readClaimPushMarkFailure: vi.fn(async () => null) }))
const { countOpenQueueSessions } = vi.hoisted(() => ({ countOpenQueueSessions: vi.fn(async () => 0) }))
vi.mock('./conversation-queue', () => ({ countOpenQueueSessions, isOpenQueueSession: () => false }))
vi.mock('./billing', () => ({ buildPlanView: () => ({ status: 'active' }), getWorkspaceSubscription: vi.fn(async () => null) }))
vi.mock('./bounded-cache', () => ({ capMapSize: () => {} }))
vi.mock('./line-channel-binding', () => ({
  findOtherWorkspacesOnChannel: vi.fn(async () => []),
  getOrLearnChannelBotUserId: vi.fn(async () => ''),
}))
vi.mock('./line-webhook-remote', () => ({ fetchLineWebhookEndpoint: vi.fn(), normalizeWebhookCompareUrl: (s: string) => s }))
vi.mock('./liff-endpoint-remote', () => ({
  collectLiffEndpointChecks: vi.fn(async () => []),
  countCampaignsWithoutUsableLiff: vi.fn(async () => 0),
}))
vi.mock('./url-reachable', () => ({ isUrlReachable: vi.fn(async () => true) }))
vi.mock('./payment', () => ({ PAYMENT_ORDERS_COLLECTION: 'paymentOrders' }))

import { collectWorkspaceAlerts } from './workspace-alerts'

/** 什麼都查不到東西的空庫：查詢回空、點讀回不存在——讓每顆探針都能跑完而不是炸掉 */
function stubDb() {
  const emptyDoc = { exists: false, data: () => undefined }
  const q: any = {}
  q.where = () => q
  q.select = () => q
  q.limit = () => q
  q.orderBy = () => q
  q.count = () => ({ get: async () => ({ data: () => ({ count: 0 }) }) })
  q.get = async () => ({ size: 0, docs: [], empty: true })
  q.doc = () => ({ get: async () => emptyDoc, ...q })
  return { collection: () => q } as any
}

function baseSettings(extra: Record<string, unknown> = {}) {
  return {
    enabled: false, // AI 沒開——D-36③ 之後不影響 handoffNotifyMissing 的判定
    sensitiveTopics: [],
    autoTagSuggest: { enabled: false },
    handoffNotify: { enabled: false, lineUserIds: [] },
    ...extra,
  }
}

describe('collectWorkspaceAlerts 權限分組（要跟前端註冊表的 requires 對齊）', () => {
  it('只有 canOperate（agent 角色）：拿得到 operate 級的每一顆，帳單/連線類不回', async () => {
    getAiSettings.mockResolvedValue(baseSettings())
    getLineWorkspaceCredentials.mockResolvedValue({ channelAccessToken: 'tok', channelSecret: '', defaultLiffId: '', lineBotUserId: '' })
    const items = await collectWorkspaceAlerts(stubDb(), 'WS', { canSettings: false, canOperate: true })
    const ids = new Set(items.map(i => i.id))

    // C-88：這三顆前端標 requires:'operate'，agent 角色必須查得到（原本放帳單組＝永遠 unknown）
    expect(ids.has('scannerStalled')).toBe(true)
    expect(ids.has('tagDiscoverySuggestions')).toBe(true)
    expect(ids.has('handoffNotifyMissing')).toBe(true)
    expect(ids.has('broadcastFailed')).toBe(true)
    // D-43②：貼標建議待審與草稿模式彙總也是 operate 級
    expect(ids.has('tagSuggestionsPending')).toBe(true)
    expect(ids.has('aiDraftsWaiting')).toBe(true)

    // 帳單/連線類（requires:'settings'）不回
    expect(ids.has('lineWebhookBroken')).toBe(false)
    expect(ids.has('quotaExceeded')).toBe(false)
    expect(ids.has('maintenanceStalled')).toBe(false)
  })

  it('只有 canSettings：operate 級的不回、帳單/連線類照回', async () => {
    getAiSettings.mockResolvedValue(baseSettings())
    getLineWorkspaceCredentials.mockResolvedValue({ channelAccessToken: '', channelSecret: '', defaultLiffId: '', lineBotUserId: '' })
    const items = await collectWorkspaceAlerts(stubDb(), 'WS', { canSettings: true, canOperate: false })
    const ids = new Set(items.map(i => i.id))

    expect(ids.has('scannerStalled')).toBe(false)
    expect(ids.has('tagDiscoverySuggestions')).toBe(false)
    expect(ids.has('handoffNotifyMissing')).toBe(false)
    expect(ids.has('tagSuggestionsPending')).toBe(false)
    expect(ids.has('aiDraftsWaiting')).toBe(false)
    expect(ids.has('maintenanceStalled')).toBe(true)
    expect(ids.has('lineWebhookBroken')).toBe(true)
  })
})

/**
 * `D-116`（2026-10-08）：以前「客人在等」與「同事接手後沒結束」併成一顆、標題用「有客人在等真人回覆」。
 * MYFEEL 實測 95 筆全是後者，小幫手照標題推論「客人說沒人回＝因為 95 位客人在等」。拆成兩顆各講各的。
 */
describe('等真人拆兩顆：humanBacklog（客人在等）與 humanStale（接手後沒結束）', () => {
  /** 對話場次的假庫：⛔ where 要回新的查詢物件（兩個條件會並行查，共用一個會互相蓋掉） */
  function sessionsDb(pendingHoursAgo: number[], humanHoursAgo: number[]) {
    const now = Date.now()
    const ts = (h: number) => ({ toMillis: () => now - h * 3600_000 })
    const rowsFor = (name: string, f: Record<string, unknown>) => {
      if (name !== 'conversationSessions') return []
      if (f.status === 'pending_human') return pendingHoursAgo.map(h => ({ handoffRequestedAt: ts(h) }))
      if (f.status === 'human_handling') return humanHoursAgo.map(h => ({ humanLastRepliedAt: ts(h) }))
      return []
    }
    const query = (name: string, f: Record<string, unknown>): any => ({
      where: (field: string, _op: string, v: unknown) => query(name, { ...f, [field]: v }),
      select: () => query(name, f),
      limit: () => query(name, f),
      orderBy: () => query(name, f),
      count: () => ({ get: async () => ({ data: () => ({ count: rowsFor(name, f).length }) }) }),
      get: async () => {
        const rows = rowsFor(name, f)
        return { size: rows.length, empty: !rows.length, docs: rows.map((r, i) => ({ id: `s${i}`, data: () => r })) }
      },
      doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
    })
    return { collection: (name: string) => query(name, {}) } as any
  }

  async function run(pending: number[], human: number[]) {
    getAiSettings.mockResolvedValue(baseSettings())
    getLineWorkspaceCredentials.mockResolvedValue({ channelAccessToken: 'tok', channelSecret: '', defaultLiffId: '', lineBotUserId: '' })
    const items = await collectWorkspaceAlerts(sessionsDb(pending, human), 'WS', { canSettings: false, canOperate: true })
    return { waiting: items.find(i => i.id === 'humanBacklog'), stale: items.find(i => i.id === 'humanStale') }
  }

  it('🔴 實測那種：只有接手後沒結束的 → 只亮 humanStale，⛔ 不講成客人在等', async () => {
    const { waiting, stale } = await run([], [20, 30, 13])
    expect(waiting?.state).toBe('clear')
    expect(stale).toMatchObject({ state: 'active', count: 3 })
  })

  it('客人要求找真人等超過門檻 → 只亮 humanBacklog；剛轉過來的不算', async () => {
    const { waiting, stale } = await run([3, 0.2], [])
    expect(waiting).toMatchObject({ state: 'active', count: 1 })
    expect(stale?.state).toBe('clear')
  })

  it('兩種都有 → 各算各的，數字不相加', async () => {
    const { waiting, stale } = await run([5], [14, 2])
    expect(waiting?.count).toBe(1)
    expect(stale?.count).toBe(1)
  })
})

describe('草稿模式的佇列彙總（D-43②）：aiDraftsWaiting 與 firstReplyBacklog 互斥', () => {
  async function run(settings: Record<string, unknown>, queueCount: number) {
    getAiSettings.mockResolvedValue(settings)
    getLineWorkspaceCredentials.mockResolvedValue({ channelAccessToken: 'tok', channelSecret: '', defaultLiffId: '', lineBotUserId: '' })
    countOpenQueueSessions.mockResolvedValue(queueCount)
    const items = await collectWorkspaceAlerts(stubDb(), 'WS', { canSettings: false, canOperate: true })
    return {
      drafts: items.find(i => i.id === 'aiDraftsWaiting'),
      backlog: items.find(i => i.id === 'firstReplyBacklog'),
    }
  }

  it('草稿模式＋佇列有 3 場 → aiDraftsWaiting 亮（無時間門檻）、firstReplyBacklog 讓位', async () => {
    const { drafts, backlog } = await run(baseSettings({ replyMode: 'draft' }), 3)
    expect(drafts?.state).toBe('active')
    expect(drafts?.count).toBe(3)
    expect(backlog?.state).toBe('clear') // ⛔兩顆同時亮＝同一份佇列被喊兩次
  })

  it('草稿模式＋佇列空 → 兩顆都不亮', async () => {
    const { drafts, backlog } = await run(baseSettings({ replyMode: 'draft' }), 0)
    expect(drafts?.state).toBe('clear')
    expect(backlog?.state).toBe('clear')
  })

  it('非草稿模式 → aiDraftsWaiting 不管佇列多長都不亮（那是 firstReplyBacklog 的 1 小時門檻管的）', async () => {
    const { drafts } = await run(baseSettings({ replyMode: 'auto' }), 5)
    expect(drafts?.state).toBe('clear')
  })

  it('設定讀不到 → aiDraftsWaiting 回 unknown（⛔不可以當成沒事），firstReplyBacklog 照舊跑保守版', async () => {
    const { drafts, backlog } = await run(null as never, 0)
    expect(drafts?.state).toBe('unknown')
    expect(backlog?.state).toBe('clear') // stub 佇列為 0；重點是它沒有跟著變 unknown
  })
})

describe('handoffNotifyMissing 判定（D-36③ 放寬）', () => {
  async function probeState(settings: Record<string, unknown>, token: string) {
    getAiSettings.mockResolvedValue(settings)
    getLineWorkspaceCredentials.mockResolvedValue({ channelAccessToken: token, channelSecret: '', defaultLiffId: '', lineBotUserId: '' })
    const items = await collectWorkspaceAlerts(stubDb(), 'WS', { canSettings: false, canOperate: true })
    return items.find(i => i.id === 'handoffNotifyMissing')?.state
  }

  it('AI 沒開、但 LINE 接上了且沒設名單 → 照樣算異常（名單擋的不只 AI 轉真人）', async () => {
    expect(await probeState(baseSettings(), 'tok')).toBe('active')
  })

  it('還沒接上 LINE → 不算異常（開通期歸開通帶管，不重複喊）', async () => {
    expect(await probeState(baseSettings(), '')).toBe('clear')
  })

  it('名單設好了 → 沒事，連憑證都不用查', async () => {
    getLineWorkspaceCredentials.mockClear()
    const state = await probeState(baseSettings({ handoffNotify: { enabled: true, lineUserIds: ['U1'] } }), 'tok')
    expect(state).toBe('clear')
    expect(getLineWorkspaceCredentials).not.toHaveBeenCalled()
  })
})

/**
 * 送不到也要講（`C-270`⑥，2026-09-27）：原本只看名單是不是空的，名單上的人都封鎖了官方帳號，
 * 小幫手也不會亮——天天照樣「發」，一則都沒送到。
 */
describe('LINE 通知送不到（C-270）', () => {
  /** 空庫＋一份送達紀錄（`lineNotifyDelivery/{wid}`） */
  function dbWithDelivery(recipients: Record<string, unknown>) {
    const base = stubDb()
    const plain = base.collection()
    return {
      collection: (name: string) => name === 'lineNotifyDelivery'
        ? { doc: () => ({ get: async () => ({ exists: true, data: () => ({ recipients }) }) }) }
        : plain,
    } as any
  }
  async function run(ids: string[], recipients: Record<string, unknown>) {
    getAiSettings.mockResolvedValue(baseSettings({
      handoffNotify: { enabled: true, lineUserIds: ids, displayNames: { U1: '小明', U2: 'Tina' } },
    }))
    getLineWorkspaceCredentials.mockResolvedValue({ channelAccessToken: 'tok', channelSecret: '', defaultLiffId: '', lineBotUserId: '' })
    const items = await collectWorkspaceAlerts(dbWithDelivery(recipients), 'WS', { canSettings: false, canOperate: true })
    return {
      missing: items.find(i => i.id === 'handoffNotifyMissing'),
      partial: items.find(i => i.id === 'lineNotifyUndeliverable'),
    }
  }

  it('🔴 名單上的人全部封鎖 → 算「沒有人會收到」（⛔ 不可以因為名單不是空的就說沒事）', async () => {
    const { missing, partial } = await run(['U1', 'U2'], { U1: { blockedAt: 1 }, U2: { failAt: 5, okAt: 1, failReason: 'x' } })
    expect(missing?.state).toBe('active')
    expect(missing?.detail).toContain('都收不到')
    expect(partial?.state).toBe('clear') // ⛔ 同一件事不兩顆一起亮
  })

  it('只有一部分收不到 → 另一顆「有人收不到」亮，而且講得出是誰、為什麼', async () => {
    const { missing, partial } = await run(['U1', 'U2'], { U1: { okAt: 10 }, U2: { blockedAt: 5 } })
    expect(missing?.state).toBe('clear')
    expect(partial?.state).toBe('active')
    expect(partial?.count).toBe(1)
    expect(partial?.detail).toContain('Tina封鎖了官方帳號')
  })

  it('舊的失敗被新的成功蓋過 → 不算收不到', async () => {
    const { partial } = await run(['U1', 'U2'], { U1: { okAt: 10 }, U2: { failAt: 5, okAt: 9 } })
    expect(partial?.state).toBe('clear')
  })

  it('🔴 LINE 一時出錯（全員都是 5xx／斷線）→ 兩顆都不亮（`C-271`⑦：原本亮「沒有人會收到」到隔天）', async () => {
    const { missing, partial } = await run(['U1', 'U2'], { U1: { okAt: 1, glitchAt: 9 }, U2: { okAt: 1, glitchAt: 9 } })
    expect(missing?.state).toBe('clear')
    expect(partial?.state).toBe('clear')
  })

  it('推播被退回說「封鎖或還沒加好友」→ 兩個都講（⛔ 不講死是封鎖）', async () => {
    const { partial } = await run(['U1', 'U2'], { U1: { okAt: 10 }, U2: { blockedAt: 5, blockedVia: 'push' } })
    expect(partial?.detail).toContain('Tina封鎖了官方帳號或還沒加好友')
  })

  it('從來沒傳過（剛加進來）→ 不算收不到', async () => {
    const { missing, partial } = await run(['U1'], {})
    expect(missing?.state).toBe('clear')
    expect(partial?.state).toBe('clear')
  })
})
