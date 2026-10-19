/**
 * 「AI 被叫太多次、大多答不出來，先停下來了」提醒（`C-8`，2026-10-20）。
 *
 * 跟護欄讀同一支（getAiCallCeilingStatus），畫面說停了就是真的停了。放帳單組（跟則數兩顆共用訂閱讀取）；
 * 則數也用完的時候讓 quotaExceeded 講（同一個「停了」，兩顆一起亮只會互相稀釋）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: '' }))

const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))
vi.mock('./line-workspace-credentials', () => ({ getLineWorkspaceCredentials: vi.fn(async () => ({ channelAccessToken: '', channelSecret: '', defaultLiffId: '', lineBotUserId: '' })) }))
vi.mock('./alert-format', () => ({ cleanReason: (s: string) => s, humanizeHours: () => '' }))
vi.mock('./ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('./ai-knowledge-sources', () => ({ KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources' }))
vi.mock('./ai-knowledge-suggest', () => ({ KNOWLEDGE_SUGGESTIONS_COLLECTION: 'knowledgeSuggestions' }))
vi.mock('./ai-feedback-events', () => ({
  AI_FEEDBACK_EVENTS_COLLECTION: 'aiFeedbackEvents',
  aggregateWrongAnswerMarks: () => new Map(),
  isChunkUnfixedSinceMark: () => false,
  readMarkDocsByReason: vi.fn(async () => []),
  pendingMarks: () => [],
}))
const { getQuotaAnswered, getCurrentMonthAiCalls } = vi.hoisted(() => ({
  getQuotaAnswered: vi.fn(async () => 0),
  getCurrentMonthAiCalls: vi.fn(async () => 0),
}))
vi.mock('./ai-usage', () => ({ getQuotaAnswered, getCurrentMonthAiCalls, getCurrentMonthTokens: vi.fn(async () => 0) }))
vi.mock('./ai-scripts', () => ({ SCRIPTS_COLLECTION: 'aiScripts' }))
vi.mock('./broken-module-refs', () => ({ findBrokenModuleRefs: vi.fn(async () => []) }))
vi.mock('./script-health', () => ({ checkScriptHealth: vi.fn(async () => ({ unreachable: [], deadEnds: [] })) }))
vi.mock('./tag-discovery', () => ({ TAG_DISCOVERY_COLLECTION: 'tagDiscovery' }))
vi.mock('./claim-push-health', () => ({ CLAIM_PUSH_MARK_ALERT_WINDOW_MS: 1, readClaimPushMarkFailure: vi.fn(async () => null) }))
vi.mock('./conversation-queue', () => ({ countOpenQueueSessions: vi.fn(async () => 0), isOpenQueueSession: () => false }))
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
vi.mock('./ai-knowledge-quota', () => ({ countWorkspaceChunks: vi.fn(async () => 0) }))

// 訂閱給真的方案表（effectivePlanOf 用真的），只換掉「讀訂閱」那一支
const { sub } = vi.hoisted(() => ({ sub: { current: null as null | Record<string, unknown> } }))
vi.mock('./billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing')>()),
  getWorkspaceSubscription: vi.fn(async () => sub.current),
}))

import { collectWorkspaceAlerts } from './workspace-alerts'

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
  return { collection: () => q, collectionGroup: () => q } as any
}

/** 管理員（帳單組）看到的那一顆 */
async function ceilingAlert(planId: string | null, calls: number, answered = 0, opts = { canSettings: true, canOperate: false }) {
  sub.current = planId ? { planId, status: 'active', currentPeriodStart: '2026-10-01', currentPeriodEnd: '2026-10-31' } : null
  getCurrentMonthAiCalls.mockResolvedValue(calls)
  getQuotaAnswered.mockResolvedValue(answered)
  const items = await collectWorkspaceAlerts(stubDb(), 'WS', opts)
  return items.find(i => i.id === 'aiCallCeiling')
}

beforeEach(() => {
  getAiSettings.mockResolvedValue({ enabled: true, sensitiveTopics: [], autoTagSuggest: { enabled: false }, handoffNotify: { enabled: false, lineUserIds: [] } })
})

describe('aiCallCeiling 提醒', () => {
  it('免費 50 則、這個月被叫 450 次（9 倍）→ 不亮', async () => {
    expect((await ceilingAlert('free', 450))?.state).toBe('clear')
  })

  it('🔴 被叫 500 次（10 倍）→ 亮，講被叫幾次、上限幾次', async () => {
    const a = await ceilingAlert('free', 500, 3)
    expect(a).toMatchObject({ state: 'active', detail: '這個月 AI 被叫了 500 次（上限 500 次）' })
    // 不帶 count：提醒帶會接在標題後面「（500）」，跟 detail 重複
    expect(a?.count).toBeUndefined()
  })

  it('則數也用完了 → 讓 quotaExceeded 講，這顆不亮', async () => {
    sub.current = { planId: 'free', status: 'active', currentPeriodStart: '2026-10-01', currentPeriodEnd: '2026-10-31' }
    getCurrentMonthAiCalls.mockResolvedValue(900)
    getQuotaAnswered.mockResolvedValue(50)
    const items = await collectWorkspaceAlerts(stubDb(), 'WS', { canSettings: true, canOperate: false })
    expect(items.find(i => i.id === 'aiCallCeiling')?.state).toBe('clear')
    expect(items.find(i => i.id === 'quotaExceeded')?.state).toBe('active')
  })

  it('內部方案、企業沒設額度 → 不亮、也不去數', async () => {
    getCurrentMonthAiCalls.mockClear()
    expect((await ceilingAlert('internal', 10_000_000))?.state).toBe('clear')
    expect((await ceilingAlert('enterprise', 10_000_000))?.state).toBe('clear')
    expect(getCurrentMonthAiCalls).not.toHaveBeenCalled()
  })

  it('讀不到訂閱 → unknown（⛔ 讀不到不等於沒停）', async () => {
    expect((await ceilingAlert(null, 0))?.state).toBe('unknown')
  })

  it('只有營運權限（每日摘要跑的那一組）→ 不查這顆（⛔ 那組每天對每個帳號跑，不為它多讀訂閱）', async () => {
    getCurrentMonthAiCalls.mockClear()
    expect(await ceilingAlert('free', 5_000, 0, { canSettings: false, canOperate: true })).toBeUndefined()
    expect(getCurrentMonthAiCalls).not.toHaveBeenCalled()
  })
})
