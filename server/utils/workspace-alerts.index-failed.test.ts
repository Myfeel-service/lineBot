/**
 * 「有知識 AI 沒學起來」（knowledgeIndexFailed，紅燈＋會推 LINE）只為**自動重試用完**的亮（`D-129`，2026-10-19）。
 *
 * 為什麼：學失敗的那幾條排程每 10 分鐘自己再試（最多 5 次）。以前一失敗就亮紅、推 LINE、小幫手叫他「幫我修」——
 * 10-16 搬家 281 條失敗那次，系統半小時內就會自己補好，紅燈只會讓他以為要自己處理。
 * 跑在假資料庫上（查詢條件不分，回什麼由這裡決定），正式庫零讀零寫。
 */
import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: '' }))

const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings }))
const { getLineWorkspaceCredentials } = vi.hoisted(() => ({ getLineWorkspaceCredentials: vi.fn() }))
vi.mock('./line-workspace-credentials', () => ({ getLineWorkspaceCredentials }))
vi.mock('./alert-format', () => ({ cleanReason: (s: string) => s, humanizeHours: (h: number) => `${Math.round(h)} 小時` }))
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
vi.mock('./conversation-queue', () => ({ countOpenQueueSessions: vi.fn(async () => 0), isOpenQueueSession: () => false }))
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

/** 空庫，只有知識卡：status=='failed' 的那幾條（重試次數照給的） */
function stubDb(failedRetryCounts: number[]) {
  const emptyDoc = { exists: false, data: () => undefined }
  const q: any = {}
  q.where = () => q
  q.select = () => q
  q.limit = () => q
  q.orderBy = () => q
  q.count = () => ({ get: async () => ({ data: () => ({ count: 0 }) }) })
  q.get = async () => ({ size: 0, docs: [], empty: true })
  q.doc = () => ({ get: async () => emptyDoc, ...q })

  const failedDocs = failedRetryCounts.map((n, i) => ({ id: `c${i}`, data: () => ({ status: 'failed', retryCount: n }) }))
  const makeChunkQ = (filters: Array<[string, unknown]>): any => {
    const isFailed = filters.some(([f, v]) => f === 'status' && v === 'failed')
    const cq: any = { ...q }
    cq.where = (f: string, _op: string, v: unknown) => makeChunkQ([...filters, [f, v]])
    cq.select = () => cq
    cq.limit = () => cq
    cq.count = () => ({ get: async () => ({ data: () => ({ count: isFailed ? failedDocs.length : 0 }) }) })
    cq.get = async () => (isFailed ? { size: failedDocs.length, docs: failedDocs, empty: !failedDocs.length } : { size: 0, docs: [], empty: true })
    return cq
  }
  return {
    collection: (name: string) => (name === 'knowledgeChunks' ? makeChunkQ([]) : q),
    collectionGroup: () => q,
  } as any
}

async function indexFailedItem(failedRetryCounts: number[]) {
  getAiSettings.mockResolvedValue({ enabled: true, sensitiveTopics: [], autoTagSuggest: { enabled: false }, handoffNotify: { enabled: false, lineUserIds: [] } })
  getLineWorkspaceCredentials.mockResolvedValue({ channelAccessToken: 'tok', channelSecret: '', defaultLiffId: '', lineBotUserId: '' })
  const items = await collectWorkspaceAlerts(stubDb(failedRetryCounts), 'WS', { canSettings: false, canOperate: true })
  return items.find(i => i.id === 'knowledgeIndexFailed')!
}

describe('knowledgeIndexFailed 只為「試了 5 次都沒學會」的亮（`D-129`）', () => {
  it('281 條學失敗、都還在自動再試（1～4 次）→ 不亮（系統會自己補好）', async () => {
    const item = await indexFailedItem(Array.from({ length: 281 }, (_, i) => 1 + (i % 4)))
    expect(item.state).toBe('clear')
  })

  it('其中 2 條試了 5 次（含手動又失敗的 6 次）→ 亮，數字只算那 2 條', async () => {
    const item = await indexFailedItem([1, 2, 5, 3, 6, 4])
    expect(item.state).toBe('active')
    expect(item.count).toBe(2)
  })

  it('沒有學失敗的 → 不亮', async () => {
    expect((await indexFailedItem([])).state).toBe('clear')
  })
})
