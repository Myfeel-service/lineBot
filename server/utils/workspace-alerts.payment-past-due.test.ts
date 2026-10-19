/**
 * 「這期的自動扣款失敗了」那顆提醒（店家的小幫手、頁面提醒帶、超管異常總覽都讀它）要寫哪天前沒扣到就降回免費
 * （`B-16`，2026-10-20）——跟扣款失敗信、帳單頁黃色警示同一個日期（graceDeadline）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: '' }))

vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn(async () => null) }))
vi.mock('./line-workspace-credentials', () => ({ getLineWorkspaceCredentials: vi.fn(async () => null) }))
vi.mock('./alert-format', () => ({ cleanReason: (s: unknown) => String(s ?? ''), humanizeHours: () => '' }))
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

// 帳單頁的方案視圖用真的（buildPlanView 算期限）；只把「讀訂閱」換成假的
const { sub } = vi.hoisted(() => ({ sub: { current: null as unknown } }))
vi.mock('./billing', async (orig) => ({
  ...(await orig<typeof import('./billing')>()),
  getWorkspaceSubscription: vi.fn(async () => sub.current),
}))

import { collectWorkspaceAlerts } from './workspace-alerts'
import { addDays, taipeiDate } from '~~/shared/time'
import { monthDayText } from '~~/shared/billing/dunning'

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

describe('paymentPastDue 提醒的說明（`B-16`）', () => {
  it('🔴 寫失敗原因＋「X 月 X 日前沒扣到就降回免費方案」', async () => {
    const start = taipeiDate()
    sub.current = {
      planId: 'lite', status: 'past_due', currentPeriodStart: start, currentPeriodEnd: addDays(start, 29),
      autoRenew: true, payuniCardToken: 'HASH', lastChargeError: '授權失敗',
    }
    const items = await collectWorkspaceAlerts(stubDb(), 'WS', { canSettings: true, canOperate: false })
    const item = items.find(i => i.id === 'paymentPastDue')
    expect(item?.state).toBe('active')
    expect(item?.detail).toBe(`卡片沒通過，銀行沒有核准這筆交易；${monthDayText(addDays(start, 3))}前沒扣到就降回免費方案`)
  })
})
