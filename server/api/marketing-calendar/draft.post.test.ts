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
/** 好友統計提案（`D-155`）用 `tags.doc(id).get()` 讀那一顆 */
const TAG_DOCS: Record<string, Record<string, unknown>> = {
  't-coffee': { workspaceId: WS, name: '在看咖啡機', aiMode: 'auto', status: 'active', description: '想買咖啡機的人', aiCriteria: '問咖啡機規格或價格' },
  't-other-ws': { workspaceId: 'ws2', name: '別家的標籤', status: 'active' },
  't-off': { workspaceId: WS, name: '停用的', status: 'inactive' },
}
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
        doc: (id: string) => ({
          get: async () => ({ exists: id in TAG_DOCS, data: () => TAG_DOCS[id] }),
        }),
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
const generateProposalCopy = vi.fn(async (..._args: unknown[]) => ({ variants: ['咖啡機有新消息', '想喝現磨的嗎', '直接回我們就好'], dropped: [] }))
vi.mock('~~/server/utils/broadcast-copy-gen', () => ({ generateBroadcastCopy, generateProposalCopy }))
vi.mock('~~/server/utils/marketing-events', () => ({ getMarketingEvents: vi.fn(async () => []) }))
let tier: 'none' | 'basic' | 'advanced' | null = null
vi.mock('~~/server/utils/broadcast-plan-gate', () => ({ workspaceBroadcastTier: vi.fn(async () => tier) }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
let body: Record<string, string> = { festivalId: 'midautumn-2026' }
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./draft.post')
const { broadcastLockText } = await import('~~/shared/billing/plans')

beforeEach(() => {
  generateBroadcastCopy.mockClear()
  generateProposalCopy.mockClear()
  tagQueries.mockClear()
  tier = null
  body = { festivalId: 'midautumn-2026' }
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

describe('好友統計的行銷提案（D-155）：帶 tagId 就是「發給這顆標籤的人」', () => {
  it('受眾就是提案那一顆（⛔ 不再配對別的標籤）、記下提案來歷、搭的檔期照帶', async () => {
    body = { tagId: 't-coffee', festivalId: 'double11-2026' }
    const r = await (handler as any)({})
    expect(generateBroadcastCopy).not.toHaveBeenCalled()
    expect(generateProposalCopy).toHaveBeenCalledTimes(1)
    // 標籤的說明＋判斷條件帶進去（AI 才知道這群人是誰）
    expect(generateProposalCopy.mock.calls[0]![2]).toMatchObject({
      tagName: '在看咖啡機',
      tagMeaning: '想買咖啡機的人；問咖啡機規格或價格',
      festival: { id: 'double11-2026' },
    })
    expect(tagQueries).not.toHaveBeenCalled()
    expect(r).toMatchObject({
      suggestedTagIds: ['t-coffee'],
      proposalTagId: 't-coffee',
      festivalId: 'double11-2026',
      festivalName: '雙 11 購物節',
      suggestedName: '在看咖啡機・雙 11 購物節',
      audienceNotice: '發送對象選好「在看咖啡機」（目前 30 位）。',
    })
  })

  it('沒搭檔期也照擬：推播不記檔期、名字就是標籤名', async () => {
    body = { tagId: 't-coffee' }
    const r = await (handler as any)({})
    expect(r).toMatchObject({ festivalId: '', festivalName: '在看咖啡機', suggestedName: '在看咖啡機' })
  })

  it('檔期剛被刪掉（找不到）不擋提案——只是不提檔期（節慶模式找不到檔期才是 400）', async () => {
    body = { tagId: 't-coffee', festivalId: 'gone-2026' }
    const r = await (handler as any)({})
    expect(r.festivalId).toBe('')
    body = { festivalId: 'gone-2026' }
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('⛔ 別家的、停用的標籤一律當找不到（404），AI 一次都沒叫', async () => {
    for (const tagId of ['t-other-ws', 't-off', 't-missing']) {
      body = { tagId }
      await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 404 })
    }
    expect(generateProposalCopy).not.toHaveBeenCalled()
  })

  it('⛔ 方案不能分眾（輕量／入門）→ 提案不擬：提案一定是依標籤發，擬了也帶不過去', async () => {
    tier = 'basic'
    body = { tagId: 't-coffee' }
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 403 })
    expect(generateProposalCopy).not.toHaveBeenCalled()
  })
})
