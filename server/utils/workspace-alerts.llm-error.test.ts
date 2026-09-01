/**
 * `llmError` 的「偶發 vs 一直在壞」分級（`D-44`② 拍板）與次數怎麼數（`H-25`④）。
 *
 * 兩件事在這裡一起釘住，因為它們是同一個問題的兩面：
 *
 * ① **偶發不該吵人**。`H-24` 修好之後，AI 連不上服務的客人已經被接住轉真人了，
 *    商家對這件事什麼也做不了。一次抖動照樣推 LINE 只會養成對紅色無感，
 *    真的整天在壞那次反而被忽略。所以一小時內連著壞 3 次以上才升成紅色。
 *
 * ② **次數本來就數不準**。舊查法數的是 `conversations.aiMeta`——每位客人一張、每輪覆寫，
 *    同一個人連壞三次只算一次。老闆 2026-09-01 看到的「1 次」就是這樣來的。
 *    ①的門檻建立在次數上，所以①要成立，②非修不可：改逐回合數 `aiTurns`。
 *
 * ⛔ 缺索引退回舊查法時**不可以假裝準**：那個模式下算出來一定偏低，
 *    所以門檻改用 24 小時筆數（寧可多吵一次，不可漏報），detail 也要寫「至少」。
 */
import { describe, it, expect, vi } from 'vitest'

// useRuntimeConfig 是 nitro 的自動注入,vitest 環境沒有——canSettings 路徑（LIFF 比對基準）會用到
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

const HOUR = 3600_000

interface TurnStub { atMs: number; userId?: string }

/**
 * 空庫 ＋ 可控的 aiTurns（逐回合）與 conversations（舊查法）。
 * `turnsThrows` 模擬「collectionGroup 索引還沒部署」。
 */
function stubDb(opts: { turns?: TurnStub[]; turnsThrows?: boolean; convs?: number[] } = {}) {
  const emptyDoc = { exists: false, data: () => undefined }
  const q: any = {}
  q.where = () => q
  q.select = () => q
  q.limit = () => q
  q.orderBy = () => q
  q.count = () => ({ get: async () => ({ data: () => ({ count: 0 }) }) })
  q.get = async () => ({ size: 0, docs: [], empty: true })
  q.doc = () => ({ get: async () => emptyDoc, ...q })

  const convDocs = (opts.convs ?? []).map(ms => ({
    data: () => ({ aiMeta: { updatedAt: { toMillis: () => ms } } }),
  }))
  const convQ: any = { ...q }
  convQ.where = () => convQ
  convQ.orderBy = () => convQ
  convQ.limit = () => convQ
  convQ.get = async () => ({ size: convDocs.length, docs: convDocs, empty: !convDocs.length })

  const turnDocs = (opts.turns ?? []).map(t => ({
    data: () => ({ createdAt: { toMillis: () => t.atMs }, userId: t.userId ?? 'u1' }),
  }))
  const turnQ: any = { ...q }
  turnQ.where = () => turnQ
  turnQ.limit = () => turnQ
  turnQ.get = async () => {
    if (opts.turnsThrows) throw new Error('9 FAILED_PRECONDITION: The query requires a COLLECTION_GROUP_ASC index')
    return { size: turnDocs.length, docs: turnDocs, empty: !turnDocs.length }
  }

  return {
    collection: (name: string) => (name === 'conversations' ? convQ : q),
    collectionGroup: () => turnQ,
  } as any
}

function settings() {
  return {
    enabled: true,
    sensitiveTopics: [],
    autoTagSuggest: { enabled: false },
    handoffNotify: { enabled: false, lineUserIds: [] },
  }
}

async function llmErrorItem(db: any) {
  getAiSettings.mockResolvedValue(settings())
  getLineWorkspaceCredentials.mockResolvedValue({ channelAccessToken: 'tok', channelSecret: '', defaultLiffId: '', lineBotUserId: '' })
  const items = await collectWorkspaceAlerts(db, 'WS', { canSettings: false, canOperate: true })
  return items.find(i => i.id === 'llmError')!
}

describe('llmError：偶發不吵人，一小時內連著壞才升紅（D-44②）', () => {
  it('一小時內 3 次 → 紅色（會推 LINE）', async () => {
    const now = Date.now()
    const item = await llmErrorItem(stubDb({ turns: [
      { atMs: now - 5 * 60_000 }, { atMs: now - 20 * 60_000 }, { atMs: now - 50 * 60_000 },
    ] }))
    expect(item.state).toBe('active')
    expect(item.severity).toBe('critical')
    expect(item.count).toBe(3)
  })

  it('一小時內只有 2 次（24 小時內共 5 次）→ 供你參考，不升紅', async () => {
    const now = Date.now()
    const item = await llmErrorItem(stubDb({ turns: [
      { atMs: now - 10 * 60_000 }, { atMs: now - 40 * 60_000 },
      { atMs: now - 6 * HOUR }, { atMs: now - 9 * HOUR }, { atMs: now - 20 * HOUR },
    ] }))
    expect(item.state).toBe('active')
    // ⛔ 不可以是 critical：客人已經被接住，商家對這件事無能為力，推 LINE 只會養成無感
    expect(item.severity).toBe('suggestion')
    expect(item.count).toBe(5)
    expect(item.detail).toContain('偶發')
  })

  it('近 24 小時內都沒發生 → 整顆不亮（更舊的不算）', async () => {
    const now = Date.now()
    const item = await llmErrorItem(stubDb({ turns: [{ atMs: now - 30 * HOUR }] }))
    expect(item.state).toBe('clear')
  })

  it('同一位客人一小時內連壞 3 次也算 3 次 —— 舊查法只會算成 1 次', async () => {
    const now = Date.now()
    const item = await llmErrorItem(stubDb({ turns: [
      { atMs: now - 3 * 60_000, userId: '同一人' },
      { atMs: now - 8 * 60_000, userId: '同一人' },
      { atMs: now - 15 * 60_000, userId: '同一人' },
    ] }))
    expect(item.count).toBe(3)
    expect(item.severity).toBe('critical')
  })
})

describe('缺索引退回舊查法時，不可以假裝數字是準的', () => {
  it('退路：數字標「至少」，而且門檻改用 24 小時筆數（寧可多吵不可漏報）', async () => {
    const now = Date.now()
    // 三筆分散在 24 小時內、一小時內只有 1 筆——照逐回合的規則不會升紅，
    // 但退路模式下每一筆都是「一位客人的最後一次」，實際次數只會更多 → 照樣升紅
    const item = await llmErrorItem(stubDb({
      turnsThrows: true,
      convs: [now - 30 * 60_000, now - 8 * HOUR, now - 18 * HOUR],
    }))
    expect(item.state).toBe('active')
    expect(item.severity).toBe('critical')
    expect(item.detail).toContain('至少')
  })

  it('退路且 24 小時內只有 1 位客人 → 仍然只是「供你參考」', async () => {
    const now = Date.now()
    const item = await llmErrorItem(stubDb({ turnsThrows: true, convs: [now - 30 * 60_000] }))
    expect(item.severity).toBe('suggestion')
    expect(item.detail).toContain('至少')
  })
})
