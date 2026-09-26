import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * POST /api/store-profile/reword（`D-89` ②）。
 * 1. 只收歡迎訊息與語氣（⛔ 標籤、月曆不能換）
 * 2. 還不認識這家店就不換（換出來是空話）
 * 3. 換不出來要講為什麼（502 帶著第一個原因），框裡的字沒動
 * 4. 用量記在維運那一側，⛔ 不寫 billable（不扣他每月的 AI 回覆額度）
 */

const SHOP = '山丘牙醫診所'
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: 'ws1', uid: 'u1' })),
}))
vi.mock('~~/server/utils/ai-usage', () => ({
  assertMaintenanceBudget: vi.fn(async () => {}),
  recordAiUsage: vi.fn(async () => {}),
}))
vi.mock('~~/server/utils/firebase', () => ({
  getDb: () => ({ collection: () => ({ doc: () => ({ get: async () => ({ data: () => ({ name: SHOP }) }) }) }) }),
}))
vi.mock('~~/server/utils/store-profile', () => ({ getStoreProfile: vi.fn() }))
vi.mock('~~/server/utils/store-draft-reword', () => ({ rewordStoreDraft: vi.fn() }))

let currentBody: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => currentBody)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./reword.post')
const { getStoreProfile } = await import('~~/server/utils/store-profile')
const { rewordStoreDraft } = await import('~~/server/utils/store-draft-reword')
const { recordAiUsage } = await import('~~/server/utils/ai-usage')
const { resetAgentRateLimit } = await import('~~/server/utils/agent-rate-limit')
const { emptyStoreProfile, setStoreProfileField } = await import('~~/shared/types/store-profile')

function readyProfile() {
  let p = emptyStoreProfile()
  for (const [k, v] of Object.entries({ industry: '醫療／健康', products: '洗牙、矯正', customers: '上班族', channel: '預約制' })) {
    p = setStoreProfileField(p, k as never, v, 'owner', 1)
  }
  return p
}

beforeEach(() => {
  resetAgentRateLimit()
  vi.mocked(getStoreProfile).mockResolvedValue(readyProfile() as never)
  vi.mocked(rewordStoreDraft).mockReset()
  vi.mocked(recordAiUsage).mockClear()
})

describe('POST /api/store-profile/reword', () => {
  it('標籤不能換（400）', async () => {
    currentBody = { key: 'tags' }
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 400 })
    expect(rewordStoreDraft).not.toHaveBeenCalled()
  })

  it('還不認識這家店就不換（409）', async () => {
    vi.mocked(getStoreProfile).mockResolvedValueOnce(emptyStoreProfile() as never)
    currentBody = { key: 'welcome' }
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 409 })
  })

  it('換成了：回新的一版；帶著店名與現在那一版去換；用量記維運那一側、不寫 billable', async () => {
    vi.mocked(rewordStoreDraft).mockResolvedValueOnce({ body: '新的一版', dropped: [], inputTokens: 120, outputTokens: 60 })
    currentBody = { key: 'welcome', current: '現在那一版' }
    const r = await (handler as any)({})
    expect(r.body).toBe('新的一版')
    expect(vi.mocked(rewordStoreDraft).mock.calls[0]).toEqual(['ws1', 'welcome', expect.objectContaining({ shopName: SHOP, current: '現在那一版' })])
    const delta = vi.mocked(recordAiUsage).mock.calls[0]![1] as Record<string, unknown>
    expect(delta).toMatchObject({ importInputTokens: 120, importOutputTokens: 60 })
    expect(delta.billable).toBeUndefined()
  })

  it('換不出來：502，講得出第一個原因，⚠️ 用量照記', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(rewordStoreDraft).mockResolvedValueOnce({ body: null, dropped: [{ text: 'x', reason: '出現了網址' }, { text: 'y', reason: '沒有店名' }], inputTokens: 90, outputTokens: 30 })
    currentBody = { key: 'tone' }
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 502, statusMessage: expect.stringContaining('出現了網址') })
    expect(recordAiUsage).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('一分鐘連按超過 8 次＝429（講得出要等幾秒）', async () => {
    vi.mocked(rewordStoreDraft).mockResolvedValue({ body: '新的', dropped: [], inputTokens: 1, outputTokens: 1 })
    currentBody = { key: 'welcome' }
    for (let i = 0; i < 8; i++) await (handler as any)({})
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 429, statusMessage: expect.stringMatching(/\d+ 秒後/) })
  })
})
