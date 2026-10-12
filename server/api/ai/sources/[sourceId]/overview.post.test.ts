import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 匯入完才補做總表（`D-123`②）。守三件事：
 * ① 新建才算一條額度，已經有總表＝原地重做、不擋；
 * ② 做出來要把來源標成型錄（generateOverview）——只建卡不標記，答題時同一份底下的商品照樣被併成一條；
 * ③ 沒做出來不可以說成功、也不記操作紀錄。
 * 正式庫零讀零寫：Firestore 全部換成記憶體裡的假物件。
 */

const WS = 'ws1'
const SRC = 'src1'
let CHUNKS: Array<Record<string, unknown>> = []
let SOURCE: Record<string, unknown> = {}
let OUTCOME = 'created'
const sourceUpdates: Array<Record<string, unknown>> = []

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/ai-usage', () => ({ assertMaintenanceBudget: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-overview', () => ({ regenerateOverviewCard: vi.fn(async () => OUTCOME) }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-knowledge-quota', () => ({
  assertKnowledgeChunkQuota: vi.fn(async () => {}),
  invalidateKnowledgeChunkCount: vi.fn(),
}))
vi.mock('~~/server/utils/ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  getSource: vi.fn(async () => ({ id: SRC, data: SOURCE })),
  invalidateCatalogSourceCache: vi.fn(),
}))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))

const db: any = {
  collection: (name: string) => ({
    where: () => ({ where: () => ({ select: () => ({ get: async () => ({ docs: CHUNKS.map(c => ({ data: () => c })) }) }) }) }),
    doc: () => ({
      update: async (data: Record<string, unknown>) => {
        if (name === 'knowledgeSources') sourceUpdates.push(data)
      },
    }),
  }),
}
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => SRC)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { assertKnowledgeChunkQuota } = await import('~~/server/utils/ai-knowledge-quota')
const { invalidateCatalogSourceCache } = await import('~~/server/utils/ai-knowledge-sources')
const { writeAuditLog } = await import('~~/server/utils/audit-log')
const { default: handler } = await import('./overview.post')
const call = () => (handler as unknown as (e: unknown) => Promise<any>)({})

beforeEach(() => {
  vi.clearAllMocks()
  sourceUpdates.length = 0
  OUTCOME = 'created'
  SOURCE = { workspaceId: WS, type: 'file', name: '型錄.pdf' }
  CHUNKS = [{ isOverview: false }, { isOverview: false }]
})

describe('匯入後補做總表', () => {
  it('沒有總表 → 先問空間夠不夠放 1 條，做出來把來源標成型錄', async () => {
    await expect(call()).resolves.toEqual({ outcome: 'created', made: true })
    expect(assertKnowledgeChunkQuota).toHaveBeenCalledWith(WS, 1, db)
    expect(sourceUpdates).toEqual([expect.objectContaining({ generateOverview: true })])
    expect(invalidateCatalogSourceCache).toHaveBeenCalledWith(WS)
    expect(writeAuditLog).toHaveBeenCalledTimes(1)
  })

  it('已經有總表（不在回收桶）→ 原地重做，不多算一條', async () => {
    CHUNKS.push({ isOverview: true, deletedAt: null })
    SOURCE.generateOverview = true
    OUTCOME = 'updated'
    await expect(call()).resolves.toEqual({ outcome: 'updated', made: true })
    expect(assertKnowledgeChunkQuota).not.toHaveBeenCalled()
    expect(sourceUpdates).toEqual([]) // 已經是型錄，不重寫
  })

  it('回收桶裡的舊總表不算「已經有」→ 照樣要問空間', async () => {
    CHUNKS.push({ isOverview: true, deletedAt: '__ts__' })
    await call()
    expect(assertKnowledgeChunkQuota).toHaveBeenCalledWith(WS, 1, db)
  })

  it('⛔ AI 沒做出來 → 不標型錄、不記操作紀錄、照實回「沒做」', async () => {
    OUTCOME = 'skipped'
    await expect(call()).resolves.toEqual({ outcome: 'skipped', made: false })
    expect(sourceUpdates).toEqual([])
    expect(writeAuditLog).not.toHaveBeenCalled()
  })

  it('空間滿了 → 在花 AI 的錢之前就擋下', async () => {
    const { regenerateOverviewCard } = await import('~~/server/utils/ai-overview')
    vi.mocked(assertKnowledgeChunkQuota).mockRejectedValueOnce(Object.assign(new Error('AI 知識量已達上限'), { statusCode: 403 }))
    await expect(call()).rejects.toMatchObject({ statusCode: 403 })
    expect(regenerateOverviewCard).not.toHaveBeenCalled()
  })

  it('別的帳號的資料 → 404', async () => {
    const { getSource } = await import('~~/server/utils/ai-knowledge-sources')
    vi.mocked(getSource).mockResolvedValueOnce(null)
    await expect(call()).rejects.toMatchObject({ statusCode: 404 })
  })
})
