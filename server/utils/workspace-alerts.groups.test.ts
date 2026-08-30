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
