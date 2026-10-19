/**
 * AI 知識量快滿了／滿了的提醒（`D-131`⑤，2026-10-19）。
 *
 * 以前方案頁只有則數進度條，知識量要按下去才收到「滿了」。照抄則數 80% 預警的機制：
 * 同一個提醒系統（小幫手面板＋帳單頁那一塊被圈起來）、同一把尺（`deriveUsageState`）、同一種分工（兩顆同時只亮一顆）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: '' }))

const { getAiSettings } = vi.hoisted(() => ({ getAiSettings: vi.fn(async () => null) }))
vi.mock('./ai-settings', () => ({ getAiSettings }))
vi.mock('./line-workspace-credentials', () => ({ getLineWorkspaceCredentials: vi.fn(async () => null) }))
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

// 方案：照訂閱的 planId 給真的方案表（免費 50 條、輕量 200 條、企業不限）
const { sub } = vi.hoisted(() => ({ sub: { current: null as null | { planId: string } } }))
vi.mock('./billing', async () => {
  const { BILLING_PLANS } = await import('~~/shared/billing/plans')
  return {
    buildPlanView: () => ({ status: 'active' }),
    getWorkspaceSubscription: vi.fn(async () => sub.current),
    effectivePlanOf: (s: { planId: keyof typeof BILLING_PLANS }) => ({ plan: BILLING_PLANS[s.planId], quota: null }),
  }
})
const { countWorkspaceChunks } = vi.hoisted(() => ({ countWorkspaceChunks: vi.fn(async () => 0) }))
vi.mock('./ai-knowledge-quota', () => ({ countWorkspaceChunks }))

import { collectWorkspaceAlerts, knowledgeQuotaProbe } from './workspace-alerts'
import { deriveUsageState } from '~~/shared/billing/plan-state'

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

async function run(planId: string | null, used: number) {
  sub.current = planId ? { planId } : null
  countWorkspaceChunks.mockResolvedValue(used)
  const items = await collectWorkspaceAlerts(stubDb(), 'WS', { canSettings: true, canOperate: false })
  return {
    full: items.find(i => i.id === 'knowledgeQuotaFull'),
    near: items.find(i => i.id === 'knowledgeQuotaRunningOut'),
  }
}

beforeEach(() => {
  countWorkspaceChunks.mockReset()
})

describe('AI 知識量提醒（跟則數 80% 同一把尺）', () => {
  it('免費方案 40／50 條（80%）→ 快滿了亮、滿了不亮', async () => {
    const { full, near } = await run('free', 40)
    expect(near).toMatchObject({ state: 'active', detail: '已用 40 / 50 條（80%）' })
    expect(full?.state).toBe('clear')
  })

  it('免費方案 50／50 條 → 滿了亮、快滿了讓位（⛔ 兩顆同時亮只會互相稀釋）', async () => {
    const { full, near } = await run('free', 50)
    expect(full).toMatchObject({ state: 'active', count: 50, detail: '已用 50 / 50 條' })
    expect(near?.state).toBe('clear')
  })

  it('39／50（78%）→ 都不亮；企業不限條數 → 都不亮、也不去數', async () => {
    const low = await run('free', 39)
    expect(low.full?.state).toBe('clear')
    expect(low.near?.state).toBe('clear')

    countWorkspaceChunks.mockClear()
    const ent = await run('enterprise', 99_999)
    expect(ent.full?.state).toBe('clear')
    expect(ent.near?.state).toBe('clear')
    expect(countWorkspaceChunks).not.toHaveBeenCalled()
  })

  it('只有客服權限（看不到帳單）→ 這兩顆不查（落點是「訂閱與付款」，前端也只給 billing.manage 看）', async () => {
    sub.current = { planId: 'free' }
    countWorkspaceChunks.mockResolvedValue(50)
    const items = await collectWorkspaceAlerts(stubDb(), 'WS', { canSettings: false, canOperate: true })
    expect(items.some(i => i.id === 'knowledgeQuotaFull' || i.id === 'knowledgeQuotaRunningOut')).toBe(false)
  })
})

describe('knowledgeQuotaProbe（純判斷）', () => {
  it('讀不到／不限 → 不亮', () => {
    expect(knowledgeQuotaProbe('full', null)).toEqual({ active: false })
    expect(knowledgeQuotaProbe('near', deriveUsageState(null, 999))).toEqual({ active: false })
  })

  it('輕量 199／200 → 快滿了（99%）', () => {
    expect(knowledgeQuotaProbe('near', deriveUsageState(200, 199))).toMatchObject({ active: true, detail: '已用 199 / 200 條（100%）' })
  })
})
