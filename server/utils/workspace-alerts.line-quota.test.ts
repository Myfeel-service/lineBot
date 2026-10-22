/**
 * 小幫手「LINE 訊息快用完了／LINE 這個月的訊息用完了」兩項（`D-146`，2026-10-22）。
 *
 * 兩顆共用同一次查詢（5 分鐘快取），同一時間只會亮一顆；放帳單／連線組（管理員看）。
 * ⛔ 問不到 LINE 是 unknown（這次查不到），不是「沒事」；沒接 LINE 不亮（沒有則數這回事）。
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
vi.mock('./ai-usage', () => ({ getQuotaAnswered: vi.fn(async () => 0), getCurrentMonthAiCalls: vi.fn(async () => 0), getCurrentMonthTokens: vi.fn(async () => 0) }))
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
vi.mock('./billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing')>()),
  getWorkspaceSubscription: vi.fn(async () => null),
}))
const { readLineMessageQuotaCached } = vi.hoisted(() => ({ readLineMessageQuotaCached: vi.fn() }))
vi.mock('./line', () => ({ readLineMessageQuotaCached }))

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

async function lineAlerts(read: unknown, opts = { canSettings: true, canOperate: false }) {
  readLineMessageQuotaCached.mockReset().mockResolvedValue(read)
  const items = await collectWorkspaceAlerts(stubDb(), 'WS', opts)
  return {
    over: items.find(i => i.id === 'lineQuotaExhausted'),
    near: items.find(i => i.id === 'lineQuotaRunningOut'),
  }
}

beforeEach(() => {
  getAiSettings.mockResolvedValue({ enabled: true, sensitiveTopics: [], autoTagSuggest: { enabled: false }, handoffNotify: { enabled: false, lineUserIds: [] } })
})

describe('LINE 訊息快用完／用完了', () => {
  it('平常（用了 2%）→ 兩顆都不亮', async () => {
    const { over, near } = await lineAlerts({ kind: 'ok', quota: { limit: 306000, used: 6810, remaining: 299190 } })
    expect(over?.state).toBe('clear')
    expect(near?.state).toBe('clear')
  })

  it('用到八成 → 只亮黃的那顆，補充講已送／上限／百分比', async () => {
    const { over, near } = await lineAlerts({ kind: 'ok', quota: { limit: 3000, used: 2480, remaining: 520 } })
    expect(near).toMatchObject({ state: 'active' })
    expect(near?.detail).toMatch(/^這個月已送約 2,480／3,000 則（83%），\d+\/1 重算$/)
    expect(over?.state).toBe('clear')
  })

  it('用完了 → 只亮紅的那顆', async () => {
    const { over, near } = await lineAlerts({ kind: 'ok', quota: { limit: 3000, used: 3000, remaining: 0 } })
    expect(over).toMatchObject({ state: 'active' })
    expect(over?.detail).toMatch(/^已送約 3,000／3,000 則，\d+\/1 重算$/)
    expect(near?.state).toBe('clear')
  })

  it('沒設上限 → 不亮（沒有用完這回事）', async () => {
    const { over, near } = await lineAlerts({ kind: 'ok', quota: { limit: null, used: 999999, remaining: null } })
    expect(over?.state).toBe('clear')
    expect(near?.state).toBe('clear')
  })

  it('還沒接 LINE → 不亮', async () => {
    const { over, near } = await lineAlerts({ kind: 'unconfigured' })
    expect(over?.state).toBe('clear')
    expect(near?.state).toBe('clear')
  })

  it('⭐ 問不到 LINE → unknown（⛔ 問不到不等於沒事）', async () => {
    const { over, near } = await lineAlerts({ kind: 'error', detail: 'LINE 超過 4 秒沒回' })
    expect(over?.state).toBe('unknown')
    expect(near?.state).toBe('unknown')
  })

  it('兩顆共用一次查詢', async () => {
    await lineAlerts({ kind: 'ok', quota: { limit: 3000, used: 10, remaining: 2990 } })
    expect(readLineMessageQuotaCached).toHaveBeenCalledTimes(1)
  })

  it('只有營運權限（客服那一組，也是每日摘要每天跑的那組）→ 不查、不回這兩顆', async () => {
    const { over, near } = await lineAlerts({ kind: 'ok', quota: { limit: 3000, used: 3000, remaining: 0 } }, { canSettings: false, canOperate: true })
    expect(over).toBeUndefined()
    expect(near).toBeUndefined()
    expect(readLineMessageQuotaCached).not.toHaveBeenCalled()
  })
})
