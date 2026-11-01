/**
 * `C-453`①：試算表來的那幾條在知識庫被手動改過、試算表改了不跟（`manualKeptCount`）——提醒中心要講。
 * 以前只有知識庫那一頁亮黃條：KIESLECT 改了試算表，AI 跟 LINE 商品卡兩週都還是舊的，沒人發現。
 * 「自動偵測失效」那顆共用同一次全掃（⛔ 不多讀一次）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn(async () => null) }))
vi.mock('./line-workspace-credentials', () => ({ getLineWorkspaceCredentials: vi.fn(async () => null) }))
vi.mock('./alert-format', () => ({ cleanReason: (s: string) => s, humanizeHours: () => '' }))
vi.mock('./ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('./ai-knowledge-sources', () => ({ KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources' }))
vi.mock('./ai-knowledge-suggest', () => ({ KNOWLEDGE_SUGGESTIONS_COLLECTION: 'knowledgeSuggestions' }))
vi.mock('./ai-feedback-events', () => ({
  AI_FEEDBACK_EVENTS_COLLECTION: 'aiFeedbackEvents',
  KNOWLEDGE_ERROR_TYPE: 'knowledgeError',
  WRONG_ANSWER_TYPE: 'wrongAnswer',
}))
vi.mock('./ai-usage', () => ({ getQuotaAnswered: vi.fn(async () => 0) }))
vi.mock('./ai-scripts', () => ({ SCRIPTS_COLLECTION: 'aiScripts', loadActiveScripts: vi.fn(async () => []) }))
vi.mock('./broken-module-refs', () => ({ findBrokenModuleRefs: vi.fn(async () => []) }))
vi.mock('./sheet-stale-modules', () => ({ findStaleSheetModules: vi.fn(async () => []) }))
vi.mock('./script-health', () => ({ checkScriptHealth: vi.fn(async () => ({ unreachable: [], deadEnds: [] })) }))
vi.mock('./tag-discovery', () => ({ TAG_DISCOVERY_COLLECTION: 'tagDiscovery' }))
vi.mock('./claim-push-health', () => ({ CLAIM_PUSH_MARK_ALERT_WINDOW_MS: 1, readClaimPushMarkFailure: vi.fn(async () => null) }))
vi.mock('./conversation-queue', () => ({ countOpenQueueSessions: vi.fn(async () => 0), isOpenQueueSession: () => false }))
vi.mock('./bounded-cache', () => ({ capMapSize: () => {} }))
vi.mock('./line-channel-binding', () => ({
  findChannelConflicts: vi.fn(async () => []),
  readLineBindingHealth: vi.fn(async () => null),
}))
vi.mock('./line-webhook-remote', () => ({ fetchLineWebhookEndpoint: vi.fn(), normalizeWebhookCompareUrl: (s: string) => s }))
vi.mock('./liff-endpoint-remote', () => ({
  fetchLiffEndpoint: vi.fn(),
  normalizeLiffCompareUrl: (s: string) => s,
}))
vi.mock('./url-reachable', () => ({ isUrlReachable: vi.fn(async () => true) }))
vi.mock('./payment', () => ({ PAYMENT_ORDERS_COLLECTION: 'paymentOrders' }))
vi.mock('./billing', () => ({ buildPlanView: () => ({}), getWorkspaceSubscription: vi.fn(async () => null), effectivePlanOf: () => ({}) }))
vi.mock('./ai-knowledge-quota', () => ({ countWorkspaceChunks: vi.fn(async () => 0) }))
vi.mock('./sheet-issues', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findSheetIssues: vi.fn(async () => ({ catalogs: [], fields: [] })),
}))

import { collectWorkspaceAlerts } from './workspace-alerts'

/**
 * 知識來源那一份全掃回這幾份；其他集合一律空的。
 * 記下「讀偵測失效／手動改過那兩格」的全掃讀了幾次（同步失敗、內容變了那兩顆本來就各自用別的條件查，不算）
 */
function stubDb(sources: Array<Record<string, unknown>>) {
  const reads = { sources: 0 }
  const emptyDoc = { exists: false, data: () => undefined }
  const make = (name: string): any => {
    const q: any = {}
    let fields: string[] = []
    q.where = () => q
    q.select = (...f: string[]) => { fields = f; return q }
    q.limit = () => q
    q.orderBy = () => q
    q.count = () => ({ get: async () => ({ data: () => ({ count: 0 }) }) })
    q.get = async () => {
      if (name !== 'knowledgeSources') return { size: 0, docs: [], empty: true }
      if (fields.includes('detectStalledAt') || fields.includes('manualKeptCount')) reads.sources++
      const docs = sources.map((s, i) => ({ id: `s${i}`, data: () => s }))
      return { size: docs.length, docs, empty: !docs.length }
    }
    q.doc = () => ({ get: async () => emptyDoc, ...q })
    return q
  }
  return { db: { collection: make } as any, reads }
}

async function run(sources: Array<Record<string, unknown>>) {
  const { db, reads } = stubDb(sources)
  const items = await collectWorkspaceAlerts(db, 'WS', { canSettings: false, canOperate: true })
  return { locked: items.find(i => i.id === 'sheetKnowledgeLocked'), stalled: items.find(i => i.id === 'knowledgeDetectStalled'), reads }
}

describe('`C-453`① 試算表被手動改過的提醒', () => {
  it('⭐ 有試算表的幾條被手動改過、不跟試算表：亮，講是哪一份、幾條', async () => {
    const { locked } = await run([
      { type: 'gsheet', name: '客服（商品資訊）', manualKeptCount: 1 },
      { type: 'gsheet', name: '客服（FAQ）', manualKeptCount: 0 },
    ])
    expect(locked).toMatchObject({ state: 'active', count: 1 })
    expect(locked!.detail).toBe('「客服（商品資訊）」有 1 條在知識庫被手動改過，試算表改了也不會跟著變')
  })

  it('同步記了是哪幾條（`C-453` 之後）：講商品名，跟商品目錄同一個講法（code review 第 6、15 條）', async () => {
    const { locked } = await run([{ type: 'gsheet', name: '客服（商品資訊）', manualKeptCount: 4, manualKeptTitles: ['A', 'B', 'C', 'D'] }])
    expect(locked).toMatchObject({ state: 'active', count: 4 })
    expect(locked!.detail).toBe('「A」、「B」、「C」等 4 個在知識庫被手動改過，試算表改了也不會跟著變')
  })

  it('對照組：都沒有、或是網址來的（不是試算表）＝不亮', async () => {
    expect((await run([{ type: 'gsheet', name: 'A', manualKeptCount: 0 }])).locked).toMatchObject({ state: 'clear' })
    expect((await run([{ type: 'url', name: '官網', manualKeptCount: 3 }])).locked).toMatchObject({ state: 'clear' })
  })

  it('跟「自動偵測失效」共用同一次讀（⛔ 不多讀一次知識來源）；那一顆照舊算得對', async () => {
    const { stalled, reads } = await run([{ type: 'url', name: '官網', detectStalledAt: 1 }, { type: 'gsheet', name: 'A', manualKeptCount: 2 }])
    expect(stalled).toMatchObject({ state: 'active', count: 1 })
    expect(reads.sources).toBe(1)
  })
})
