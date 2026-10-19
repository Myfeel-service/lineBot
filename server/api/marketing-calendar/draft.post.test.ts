import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 首頁檔期「為這一檔擬推播」照方案先講（`C-352`①，2026-10-19 老闆「照建議」）。
 *
 * 以前三種方案都照擬：免費方案擬好了推播頁卻整則發不出去（還白花一次 AI）；
 * 輕量／入門方案 MiniMe 幫他挑了標籤，到推播頁那一格是鎖住的，得自己改回全部好友。
 *  - 免費：⛔ 不擬，回推播頁鎖住時那一句（AI 一次都沒叫）
 *  - 輕量／入門：照擬（要的是文案），⛔ 不挑標籤，受眾那句就是推播頁那一句
 *  - 成長／讀不到方案：跟以前一樣挑標籤
 */

const WS = 'ws1'

vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'u1', role: 'agent' })),
}))
vi.mock('~~/server/utils/ai-usage', () => ({ assertMaintenanceBudget: vi.fn(async () => {}) }))
const tagQueries = vi.fn()
vi.mock('~~/server/utils/firebase', () => ({
  getDb: () => ({
    collection: (name: string) => {
      const chain: any = {
        where: () => chain,
        limit: () => chain,
        get: async () => {
          tagQueries(name)
          return { docs: [{ id: 't-coffee', data: () => ({ name: '在看咖啡機', aiMode: 'suggest' }) }] }
        },
      }
      return chain
    },
  }),
}))
vi.mock('~~/server/utils/store-profile', () => ({
  getStoreProfile: vi.fn(async () => ({ fields: { industry: { value: '咖啡' }, products: { value: '咖啡機' } } })),
}))
vi.mock('~~/shared/types/store-profile', () => ({ isStoreProfileReady: () => true }))
vi.mock('~~/server/utils/tag-member-count', () => ({ memberCountsForTagIds: vi.fn(async () => ({ 't-coffee': 30 })) }))
vi.mock('~~/server/utils/inactive-tag', () => ({ INACTIVE_TAG_CODE: 'inactive' }))
const generateBroadcastCopy = vi.fn(async () => ({ variants: ['中秋連假照常出貨', '中秋禮盒開賣', '中秋快樂'], dropped: [] }))
vi.mock('~~/server/utils/broadcast-copy-gen', () => ({ generateBroadcastCopy }))
vi.mock('~~/server/utils/marketing-events', () => ({ getMarketingEvents: vi.fn(async () => []) }))
let tier: 'none' | 'basic' | 'advanced' | null = null
vi.mock('~~/server/utils/broadcast-plan-gate', () => ({ workspaceBroadcastTier: vi.fn(async () => tier) }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => ({ festivalId: 'midautumn-2026' }))
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./draft.post')
const { broadcastLockText } = await import('~~/shared/billing/plans')

beforeEach(() => {
  generateBroadcastCopy.mockClear()
  tagQueries.mockClear()
  tier = null
})

describe('為這一檔擬推播：照方案先講（C-352①）', () => {
  it('免費方案 → 403、句子是推播頁鎖住時那一句，⛔ AI 一次都沒叫', async () => {
    tier = 'none'
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 403, statusMessage: broadcastLockText('none') })
    expect(generateBroadcastCopy).not.toHaveBeenCalled()
  })

  it('輕量／入門方案 → 照擬文案，⛔ 不挑標籤（挑了推播頁那一格是鎖住的），受眾那句就是推播頁那一句', async () => {
    tier = 'basic'
    const r = await (handler as any)({})
    expect(r.variants).toHaveLength(3)
    expect(r.suggestedTagIds).toEqual([])
    expect(r.audienceNotice).toBe(broadcastLockText('basic'))
    expect(tagQueries).not.toHaveBeenCalled()
  })

  it('對照組：成長方案照舊挑標籤（證明上一條不挑是因為方案，不是配不到）', async () => {
    tier = 'advanced'
    const r = await (handler as any)({})
    expect(r.suggestedTagIds).toEqual(['t-coffee'])
    expect(r.audienceNotice).not.toBe(broadcastLockText('basic'))
  })

  it('讀不到方案（null）→ 不擋（fail-open，同推播頁與送出端）', async () => {
    tier = null
    const r = await (handler as any)({})
    expect(generateBroadcastCopy).toHaveBeenCalledTimes(1)
    expect(r.suggestedTagIds).toEqual(['t-coffee'])
  })
})
