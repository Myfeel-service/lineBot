import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 匯入前的知識量檢查算對沒有（`C-296`）。以前兩個地方算錯：
 *  ① 總表也是一條、也算額度——沒算進去，剛好滿的時候會超收 1 條；
 *  ② 「更新這一份」的舊卡等一下就進回收桶——照算的話，換一份新版說明書會被自己的舊卡擋下。
 * ⛔ 外帳號的來源 id 數出來要是 0：不然拿別家的 id 就能替自己灌出額度。
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn(() => ({})) }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/ai-usage', () => ({
  assertMaintenanceBudget: vi.fn(async () => {}),
  recordAiUsage: vi.fn(async () => {}),
}))
vi.mock('~~/server/utils/ai-knowledge-quota', () => ({
  // 檢查之後的建檔流程不在這支測試的範圍：擋在這裡就好
  assertKnowledgeChunkQuota: vi.fn(async () => { throw Object.assign(new Error('stop-after-quota'), { statusCode: 499 }) }),
  invalidateKnowledgeChunkCount: vi.fn(),
}))
vi.mock('~~/server/utils/ai-knowledge-sources', () => ({
  countSourceChunks: vi.fn(async (_db: unknown, ws: string, id: string) => (ws === WS && id === 'srcMine' ? 40 : 0)),
  recycleSourceChunks: vi.fn(async () => 0),
  invalidateCatalogSourceCache: vi.fn(),
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
}))
vi.mock('~~/server/utils/ai-knowledge-folder-guard', () => ({ resolveKnowledgeFolderId: vi.fn(async () => null) }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({
  addWorkspaceProductName: vi.fn(),
  createKnowledgeChunk: vi.fn(),
  normalizeChunkInput: (raw: any) => ({ title: String(raw?.title ?? ''), content: String(raw?.content ?? ''), tags: [], questions: [], sourceId: null, isOverview: false }),
  validateChunkInput: () => null,
}))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { assertKnowledgeChunkQuota } = await import('~~/server/utils/ai-knowledge-quota')
const { default: handler } = await import('./bulk-create.post')

const call = () => (handler as unknown as (e: unknown) => Promise<any>)({}).catch((e: any) => e)
const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `第 ${i + 1} 條`, content: '內容' }))
const addingAsked = () => vi.mocked(assertKnowledgeChunkQuota).mock.calls[0]![1]

beforeEach(() => vi.clearAllMocks())

describe('bulk-create 的知識量檢查', () => {
  it('總表也算一條：3 條＋總表＝要 4 條的空間', async () => {
    body = { source: { type: 'file', name: '型錄.pdf' }, chunks: cards(3), overviewCard: { title: '總表', content: '我們有 A、B、C' } }
    await call()
    expect(addingAsked()).toBe(4)
  })

  it('「更新這一份」：舊的 40 條會退場，新版 42 條只多佔 2 條', async () => {
    body = { source: { type: 'file', name: '說明書.pdf' }, chunks: cards(42), replaceSourceId: 'srcMine' }
    await call()
    expect(addingAsked()).toBe(2)
  })

  it('⛔ 拿別家的來源 id 來「更新」，不會被算成騰出空間', async () => {
    body = { source: { type: 'file', name: '說明書.pdf' }, chunks: cards(3), replaceSourceId: 'srcTheirs' }
    await call()
    expect(addingAsked()).toBe(3)
  })
})
