import { describe, expect, it, vi } from 'vitest'

/**
 * 超管成本總覽（`D-130`②）：AI 花費照實際模型算，並且回報「這個月有多少是用大模型價格估的」，
 * 畫面靠它講那一句；超管帳號列表的「客人對話花多少」也走同一份算式（以前自己寫死一份 flash 單價）。
 */

vi.mock('~~/server/utils/workspace-auth', () => ({ requireSuperAdmin: vi.fn(async () => {}) }))

const usageDocs: Record<string, any[]> = {
  202610: [
    {
      workspaceId: 'w1',
      period: '202610',
      invocations: 100,
      inputTokens: 1_000_000, // 10/19 前的 600k 沒明細＋之後 400k 是 lite
      outputTokens: 0,
      modelTokens: { conversation: { flashLite: { input: 400_000 } } },
    },
  ],
  202609: [{ workspaceId: 'w1', period: '202609', inputTokens: 1_000_000, outputTokens: 0 }],
}
const fakeDb = {
  collection: (col: string) => ({
    get: async () => ({ docs: col === 'workspaces' ? [{ id: 'w1', data: () => ({ name: 'MYFEEL' }) }] : [] }),
    where: (_f: string, _op: string, v: string) => ({ get: async () => ({ docs: (usageDocs[v] ?? []).map(d => ({ data: () => d })) }) }),
  }),
}
vi.stubGlobal('getDb', () => fakeDb)
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
let query: Record<string, string> = {}
vi.stubGlobal('getQuery', () => query)

const { default: costsHandler } = await import('./costs.get')
const { default: workspacesHandler } = await import('./workspaces/index.get')

describe('GET /api/admin/super/costs 照模型分價', () => {
  it('有明細的照 lite 價、剩下的照 flash；並回報有多少是照大模型價格估的', async () => {
    query = { period: '202610' }
    const res = await (costsHandler as any)({})
    // 400k × 0.10 ＋ 600k × 0.30 ＝ 0.04 ＋ 0.18
    expect(res.totals.conversationCostUsd).toBeCloseTo(0.22, 6)
    expect(res.modelPricing).toEqual({ unsplitTokens: 600_000, genTokens: 1_000_000 })
    // 上個月整月都沒明細：照 flash 價
    expect(res.prevTotalCostUsd).toBeCloseTo(0.30, 6)
  })

  it('整個月都是舊資料：unsplit＝全部（畫面講「這個月是用大模型的價格估的」）', async () => {
    query = { period: '202609' }
    const res = await (costsHandler as any)({})
    expect(res.modelPricing).toEqual({ unsplitTokens: 1_000_000, genTokens: 1_000_000 })
  })
})

describe('GET /api/admin/super/workspaces 客人對話花費', () => {
  it('跟成本總覽同一份算式（照模型）——以前自己寫死 flash 單價，兩頁會對不起來', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T04:00:00Z'))
    try {
      const rows = await (workspacesHandler as any)({})
      expect(rows[0].usage.conversationCostUsd).toBeCloseTo(0.22, 4)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
