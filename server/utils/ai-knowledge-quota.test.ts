/**
 * 知識量上限（`D-69` 拍板④）。
 *
 * 重點在「數對」與「擋對」：回收桶的卡不算、舊資料沒有 isDeleted 欄位也要數得到、
 * 到頂了才擋、企業／內部方案不擋、訂閱讀不到時放行。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

vi.mock('./firebase', () => ({ getDb: () => { throw new Error('test 必須自帶 db') } }))
vi.mock('./billing', () => ({ getWorkspacePlan: vi.fn() }))
vi.mock('./ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))

import {
  assertKnowledgeChunkQuota,
  countWorkspaceChunks,
  invalidateKnowledgeChunkCount,
} from './ai-knowledge-quota'
import { getWorkspacePlan } from './billing'
import { BILLING_PLANS } from '~~/shared/billing/plans'

/**
 * 假 Firestore：只認得這裡用到的兩段查詢——
 * `where(workspaceId)` 的總數，以及再 `where(isDeleted==true)` 的墓碑數。
 */
function makeDb(total: number, deleted: number) {
  let counted = 0
  const q = (isDeletedFilter: boolean): any => ({
    where: () => q(true),
    count: () => ({ get: async () => { counted++; return { data: () => ({ count: isDeletedFilter ? deleted : total }) } } }),
  })
  return {
    db: { collection: () => ({ where: () => q(false) }) } as any,
    aggregations: () => counted,
  }
}

function planWithChunkLimit(limit: number | null) {
  vi.mocked(getWorkspacePlan).mockResolvedValue({ ...BILLING_PLANS.lite, knowledgeChunks: limit } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  invalidateKnowledgeChunkCount()
})

describe('數現有幾條', () => {
  it('回收桶的卡不算（總數扣掉墓碑）', async () => {
    const { db } = makeDb(120, 20)
    expect(await countWorkspaceChunks('ws1', db)).toBe(100)
  })

  it('同一個帳號連問兩次只打一次資料庫（快取；讀取費會咬人）', async () => {
    const { db, aggregations } = makeDb(10, 0)
    await countWorkspaceChunks('ws1', db)
    await countWorkspaceChunks('ws1', db)
    expect(aggregations()).toBe(2) // 一次呼叫 = 兩段聚合（總數 + 墓碑），第二次全走快取
  })
})

describe('要加卡的時候擋不擋', () => {
  it('還有空間 → 放行', async () => {
    planWithChunkLimit(200)
    const { db } = makeDb(100, 0)
    await expect(assertKnowledgeChunkQuota('ws1', 1, db)).resolves.toBeUndefined()
  })

  it('剛好填滿 → 放行（上限是可以用到的，不是用不到的）', async () => {
    planWithChunkLimit(200)
    const { db } = makeDb(199, 0)
    await expect(assertKnowledgeChunkQuota('ws1', 1, db)).resolves.toBeUndefined()
  })

  it('超過一張就擋，而且訊息要講得出現況與上限', async () => {
    planWithChunkLimit(200)
    const { db } = makeDb(200, 0)
    await expect(assertKnowledgeChunkQuota('ws1', 1, db)).rejects.toMatchObject({ statusCode: 403 })
    await expect(assertKnowledgeChunkQuota('ws1', 1, db)).rejects.toThrow(/200/)
  })

  it('整批匯入是「現有 + 這批」一起看，不是一張一張過', async () => {
    planWithChunkLimit(200)
    const { db } = makeDb(150, 0)
    await expect(assertKnowledgeChunkQuota('ws1', 60, db)).rejects.toThrow(/60/)
    await expect(assertKnowledgeChunkQuota('ws1', 50, db)).resolves.toBeUndefined()
  })

  /**
   * ⛔ 這條守著整個 `D-69` 拍板④的用意：份數制會鎖死學習迴圈，條數制不該重蹈覆轍。
   * 免費層 50 條，教 AI 幾十件事都還有空間。
   */
  it('免費層仍容得下日常「教 AI 一件新的事」', async () => {
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.free as any)
    const { db } = makeDb(30, 0)
    await expect(assertKnowledgeChunkQuota('ws1', 1, db)).resolves.toBeUndefined()
  })
})

describe('不該擋的情況', () => {
  it('企業／內部方案不限條數', async () => {
    planWithChunkLimit(null)
    const { db } = makeDb(999_999, 0)
    await expect(assertKnowledgeChunkQuota('ws1', 100, db)).resolves.toBeUndefined()
  })

  it('訂閱讀不到（資料庫故障）→ 放行，不要把客人鎖在門外', async () => {
    vi.mocked(getWorkspacePlan).mockResolvedValue(null)
    const { db } = makeDb(999, 0)
    await expect(assertKnowledgeChunkQuota('ws1', 1, db)).resolves.toBeUndefined()
  })

  it('adding 為 0（沒有要新增）→ 連查都不用查', async () => {
    planWithChunkLimit(1)
    const { db, aggregations } = makeDb(999, 0)
    await expect(assertKnowledgeChunkQuota('ws1', 0, db)).resolves.toBeUndefined()
    expect(aggregations()).toBe(0)
  })
})
