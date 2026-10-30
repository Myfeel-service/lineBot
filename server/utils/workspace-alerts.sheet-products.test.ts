/**
 * 試算表商品五顆提醒（`C-438`，`D-166` ⑤ 規格 §5.6）：講得出是哪幾個商品／哪個模組、哪一欄。
 * ⛔ 查不到（商品清單讀失敗）＝unknown，不是「沒事」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: '' }))

vi.mock('./ai-settings', () => ({ getAiSettings: vi.fn(async () => null) }))
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
vi.mock('./ai-scripts', () => ({ SCRIPTS_COLLECTION: 'aiScripts', loadActiveScripts: vi.fn(async () => []) }))
vi.mock('./broken-module-refs', () => ({ findBrokenModuleRefs: vi.fn(async () => []) }))
vi.mock('./sheet-stale-modules', () => ({ findStaleSheetModules: vi.fn(async () => []) }))
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
vi.mock('./billing', () => ({ buildPlanView: () => ({}), getWorkspaceSubscription: vi.fn(async () => null), effectivePlanOf: () => ({}) }))
vi.mock('./ai-knowledge-quota', () => ({ countWorkspaceChunks: vi.fn(async () => 0) }))
const { findSheetIssues } = vi.hoisted(() => ({ findSheetIssues: vi.fn() }))
vi.mock('./sheet-issues', async (orig) => ({ ...(await orig<Record<string, unknown>>()), findSheetIssues }))

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
  return { collection: () => q } as any
}

const IDS = ['sheetCatalogOverflow', 'sheetProductNoImage', 'sheetProductMissing', 'sheetProductRenameUnsure', 'sheetFieldMissing'] as const
const catalog = (over: Record<string, unknown> = {}) => ({ flowId: 'cat1', flowName: '商品目錄', sourceId: 'src1', overflow: [], noImage: [], missing: [], renameUnsure: [], ...over })

async function run() {
  const items = await collectWorkspaceAlerts(stubDb(), 'WS', { canSettings: false, canOperate: true })
  return Object.fromEntries(IDS.map(id => [id, items.find(i => i.id === id)]))
}

beforeEach(() => { findSheetIssues.mockReset() })

describe('試算表商品五顆提醒', () => {
  it('⭐ 每一顆講得出是哪幾個（照規格那張表的話）', async () => {
    findSheetIssues.mockResolvedValue({
      catalogs: [catalog({ overflow: ['K', 'L'], noImage: ['兩全奇美燈'], missing: ['YiMi'], renameUnsure: ['10S'] })],
      fields: [{ flowId: 'tpl', flowName: '商品資訊範本', field: '額外資訊', row: null, kind: 'field' }],
    })
    const r = await run()
    expect(r.sheetCatalogOverflow).toMatchObject({ state: 'active', count: 2, detail: '勾了 12 個，目錄只放得下 10 個：「K」、「L」沒放上去' })
    expect(r.sheetProductNoImage).toMatchObject({ state: 'active', count: 1, detail: '「兩全奇美燈」抓不到商品圖，先不放進目錄' })
    expect(r.sheetProductMissing).toMatchObject({ state: 'active', count: 1, detail: '試算表少了「YiMi」，AI 也答不出了' })
    expect(r.sheetProductRenameUnsure).toMatchObject({ state: 'active', count: 1, detail: '試算表上找不到「10S」了，是改名嗎？' })
    expect(r.sheetFieldMissing).toMatchObject({ state: 'active', count: 1, detail: '範本「商品資訊範本」用到的「額外資訊」這一欄找不到了，那一行不會顯示' })
    // 五顆共用同一次查詢
    expect(findSheetIssues).toHaveBeenCalledTimes(1)
  })

  it('兩個目錄照同一份表：同一個商品只算一次', async () => {
    findSheetIssues.mockResolvedValue({ catalogs: [catalog({ missing: ['YiMi'] }), catalog({ flowId: 'cat2', missing: ['YiMi'] })], fields: [] })
    expect((await run()).sheetProductMissing).toMatchObject({ count: 1 })
  })

  it('沒事：五顆都是 clear', async () => {
    findSheetIssues.mockResolvedValue({ catalogs: [catalog()], fields: [] })
    const r = await run()
    for (const id of IDS) expect(r[id]?.state).toBe('clear')
  })

  it('⛔ 讀不到：五顆都是 unknown（查不到不等於沒問題）', async () => {
    findSheetIssues.mockRejectedValue(new Error('firestore down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await run()
    for (const id of IDS) expect(r[id]?.state).toBe('unknown')
    warn.mockRestore()
  })
})
