import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reportAiCall } from '~~/server/utils/ai-usage-calls'

/**
 * POST /api/store-profile/infer（老店反推）的記帳（`C-338`①：以前完全沒記）。
 * 從既有資料猜輪廓＝整理知識庫那桶（跟讀網站認識你的店同一桶）；JSON 壞掉那次也付了錢。
 */

vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: 'ws1', uid: 'u1' })),
}))
vi.mock('~~/server/utils/ai-usage', () => ({
  assertMaintenanceBudget: vi.fn(async () => {}),
  recordAiUsage: vi.fn(async () => {}),
}))
const fakeDb = { collection: () => ({ doc: () => ({ get: async () => ({ data: () => ({ name: '山丘咖啡' }) }) }) }) }
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => fakeDb }))
vi.mock('~~/server/utils/store-profile', () => ({
  getStoreProfile: vi.fn(async () => ({ fields: {} })),
  saveStoreProfile: vi.fn(async () => {}),
}))
vi.mock('~~/server/utils/store-profile-infer', () => ({
  inferProfileFromExisting: vi.fn(),
  hasEnoughToInfer: () => true,
  describeInferSources: () => '從知識庫猜的',
}))
vi.mock('~~/shared/types/store-profile', async importOriginal => ({
  ...(await importOriginal<typeof import('~~/shared/types/store-profile')>()),
  mergeAiGuesses: (profile: unknown) => ({ profile, filled: ['industry'], skippedOwnerEdited: [] }),
  isStoreProfileReady: () => false,
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./infer.post')
const { inferProfileFromExisting } = await import('~~/server/utils/store-profile-infer')
const { recordAiUsage } = await import('~~/server/utils/ai-usage')

const FLASH = 'gemini-2.5-flash'

beforeEach(() => {
  vi.mocked(inferProfileFromExisting).mockReset()
  vi.mocked(recordAiUsage).mockClear()
})

describe('POST /api/store-profile/infer 記帳', () => {
  it('猜一次＝記進整理知識庫那桶，照實際模型', async () => {
    vi.mocked(inferProfileFromExisting).mockImplementationOnce(async () => {
      reportAiCall({ model: FLASH, inputTokens: 3000, outputTokens: 400 })
      return { guesses: { industry: '咖啡' }, sources: {} as never, inputTokens: 3000, outputTokens: 400 }
    })
    const res = await (handler as any)({})
    expect(res.ok).toBe(true)
    expect(recordAiUsage).toHaveBeenCalledWith('ws1', {
      inputTokens: 3000,
      outputTokens: 400,
      importInputTokens: 3000,
      importOutputTokens: 400,
      modelTokens: { build: { flash: { input: 3000, output: 400 } } },
    }, fakeDb)
  })

  it('模型回的 JSON 壞掉：照樣丟錯給畫面，但那次的錢照記', async () => {
    vi.mocked(inferProfileFromExisting).mockImplementationOnce(async () => {
      reportAiCall({ model: FLASH, inputTokens: 3000, outputTokens: 900 })
      throw Object.assign(new Error('Gemini JSON parse failed'), { statusCode: 502 })
    })
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 502 })
    expect(recordAiUsage).toHaveBeenCalledWith('ws1', expect.objectContaining({ importInputTokens: 3000, importOutputTokens: 900 }), fakeDb)
  })
})
