/**
 * 「有推播還沒排上，不會自動送」（broadcastNotScheduled，`C-433`）。
 *
 * 為什麼：`D-167`② 之後存草稿會記住選好的時間，但⛔ 排程器只認「排程中」——沒人回來按「驗證並排程」，
 * 到時間照樣不會送。2026-10-29 MYFEEL 三則就是這樣，要到 10/31 時間過了、客人沒收到才會發現。
 * 跑在假資料庫上（回什麼由這裡決定），正式庫零讀零寫。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

/** 台灣時間（+08:00）→ Date */
const tw = (s: string) => new Date(`${s}+08:00`)

type Draft = { name: string; plannedScheduleAt?: Date | null }

/** 空庫，只有 broadcasts 的草稿；記下推播那一支查了什麼條件 */
function stubDb(drafts: Draft[]) {
  const emptyDoc = { exists: false, data: () => undefined }
  const q: any = {}
  q.where = () => q
  q.select = () => q
  q.limit = () => q
  q.orderBy = () => q
  q.count = () => ({ get: async () => ({ data: () => ({ count: 0 }) }) })
  q.get = async () => ({ size: 0, docs: [], empty: true })
  q.doc = () => ({ get: async () => emptyDoc, ...q })

  const draftQueries: Array<{ filters: Array<[string, unknown]>; limit?: number }> = []
  const makeBcQ = (filters: Array<[string, unknown]>, limit?: number): any => {
    const bq: any = { ...q }
    bq.where = (f: string, _op: string, v: unknown) => makeBcQ([...filters, [f, v]], limit)
    bq.select = () => bq
    bq.limit = (n: number) => makeBcQ(filters, n)
    bq.get = async () => {
      const isDraft = filters.some(([f, v]) => f === 'status' && v === 'draft')
      if (!isDraft) return { size: 0, docs: [], empty: true }
      draftQueries.push({ filters, limit })
      const docs = drafts.slice(0, limit ?? drafts.length).map((d, i) => ({ id: `b${i}`, data: () => d }))
      return { size: docs.length, docs, empty: !docs.length }
    }
    return bq
  }
  const db = {
    collection: (name: string) => (name === 'broadcasts' ? makeBcQ([]) : q),
    collectionGroup: () => q,
  } as any
  return { db, draftQueries }
}

async function notScheduledItem(drafts: Draft[]) {
  getAiSettings.mockResolvedValue({ enabled: true, sensitiveTopics: [], autoTagSuggest: { enabled: false }, handoffNotify: { enabled: false, lineUserIds: [] } })
  getLineWorkspaceCredentials.mockResolvedValue({ channelAccessToken: 'tok', channelSecret: '', defaultLiffId: '', lineBotUserId: '' })
  const { db, draftQueries } = stubDb(drafts)
  const items = await collectWorkspaceAlerts(db, 'WS', { canSettings: false, canOperate: true })
  return { item: items.find(i => i.id === 'broadcastNotScheduled')!, draftQueries }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(tw('2026-10-30T17:00:00'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('broadcastNotScheduled：推播記了時間、還沒排上（`C-433`）', () => {
  it('小滑手記了 10/31 18:00、還是草稿 → 亮，講是哪一則、幾點', async () => {
    const { item } = await notScheduledItem([{ name: '小滑手＿專案倒數推播', plannedScheduleAt: tw('2026-10-31T18:00:00') }])
    expect(item.state).toBe('active')
    expect(item.count).toBe(1)
    expect(item.detail).toBe('「小滑手＿專案倒數推播」記了 10/31 下午6:00 要送')
  })

  it('草稿沒記時間（10/30 MYFEEL 那三則現在的樣子）→ 不亮：沒說要哪天送，不是這顆的事', async () => {
    const { item } = await notScheduledItem([
      { name: '小滑手＿專案倒數推播' },
      { name: '乾淨方MAX-10/31集資結束推播', plannedScheduleAt: null },
    ])
    expect(item.state).toBe('clear')
  })

  it('只查這個帳號的草稿（⛔ 排程中的不算：那顆會送）', async () => {
    const { draftQueries } = await notScheduledItem([])
    expect(draftQueries).toHaveLength(1)
    expect(draftQueries[0]!.filters).toEqual(expect.arrayContaining([['workspaceId', 'WS'], ['status', 'draft']]))
  })

  it('一則還沒到、一則昨天就過了 → 兩則都算，講還來得及的那一則（最早要送的）', async () => {
    const { item } = await notScheduledItem([
      { name: '昨天那則', plannedScheduleAt: tw('2026-10-29T12:00:00') },
      { name: '下週那則', plannedScheduleAt: tw('2026-11-05T09:00:00') },
      { name: '明晚那則', plannedScheduleAt: tw('2026-10-31T18:00:00') },
    ])
    expect(item.state).toBe('active')
    expect(item.count).toBe(3)
    expect(item.detail).toBe('「明晚那則」記了 10/31 下午6:00 要送')
  })

  it('時間已經過了（三天內）→ 亮，改講「沒有送出」；過了超過三天 → 不再講', async () => {
    const recent = await notScheduledItem([{ name: '小滑手＿專案倒數推播', plannedScheduleAt: tw('2026-10-29T18:00:00') }])
    expect(recent.item.state).toBe('active')
    expect(recent.item.detail).toBe('「小滑手＿專案倒數推播」記的 10/29 下午6:00 已經過了，沒有送出')

    const old = await notScheduledItem([{ name: '小滑手＿專案倒數推播', plannedScheduleAt: tw('2026-10-27T16:00:00') }])
    expect(old.item.state).toBe('clear')
  })

  it('草稿多到沒看完、看到的都沒記時間 → 講「這次查不到」，⛔ 不講沒事（後面那幾則可能有）', async () => {
    const { item, draftQueries } = await notScheduledItem(Array.from({ length: 150 }, (_, i) => ({ name: `草稿${i}` })))
    expect(draftQueries[0]!.limit).toBe(100)
    expect(item.state).toBe('unknown')
  })

  it('草稿多到沒看完、但看到的就有記時間的 → 照樣亮', async () => {
    const drafts: Draft[] = Array.from({ length: 150 }, (_, i) => ({ name: `草稿${i}` }))
    drafts[3] = { name: '有記時間的', plannedScheduleAt: tw('2026-10-31T18:00:00') }
    const { item } = await notScheduledItem(drafts)
    expect(item.state).toBe('active')
  })
})
