import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 超管金流總覽的「自動扣款失敗」清單（`B-43`②）：查不了要回 null，⛔ 不當成「沒有人扣款失敗」 */

vi.mock('~~/server/utils/workspace-auth', () => ({ requireSuperAdmin: vi.fn(async () => ({ uid: 'super-1' })) }))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn(() => db) }))
vi.mock('~~/server/utils/billing-dunning', () => ({ readDunningRows: vi.fn() }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)

const db = {
  collection: () => {
    const q: any = {
      orderBy: () => q,
      limit: () => q,
      where: () => q,
      get: async () => ({ docs: [] }),
      count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
    }
    return q
  },
}

const { default: handler } = await import('./payments.get')
const { readDunningRows } = await import('~~/server/utils/billing-dunning')
const call = () => (handler as unknown as (e: unknown) => Promise<any>)({})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/admin/super/payments：自動扣款失敗清單', () => {
  it('查得到 → 原樣帶出', async () => {
    vi.mocked(readDunningRows).mockResolvedValueOnce([{ workspaceId: 'ws1', state: 'past_due' } as any])
    expect((await call()).dunning).toEqual([{ workspaceId: 'ws1', state: 'past_due' }])
  })

  it('🔴 查不了 → null（不是空清單）；付款紀錄照常', async () => {
    vi.mocked(readDunningRows).mockRejectedValueOnce(new Error('UNAVAILABLE'))
    const r = await call()
    expect(r.dunning).toBeNull()
    expect(r.orders).toEqual([])
  })
})
