import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 圖文選單生圖的記帳（`C-338`③）：一張實際約 US$0.039，以前當文字模型的價記成約 US$0.003（少 12 倍）。
 * 這裡走真的 gemini.ts（只把 Gemini 的 HTTP 換成假的），從端點一路驗到「月結桶算出來的錢」。
 */

vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: 'ws1', uid: 'u1' })),
}))
vi.mock('~~/server/utils/ai-usage', () => ({
  assertMaintenanceBudget: vi.fn(async () => {}),
  recordAiUsage: vi.fn(async () => {}),
}))
const fakeDb = { name: 'fake-db' }
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => fakeDb }))

let currentBody: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => currentBody)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))
vi.stubGlobal('useRuntimeConfig', () => ({ geminiApiKey: 'test-key' }))

const { default: handler } = await import('./generate-background.post')
const { recordAiUsage, assertMaintenanceBudget } = await import('~~/server/utils/ai-usage')
const { bucketAiCosts } = await import('~~/server/utils/ai-cost-buckets')

let reply: unknown
beforeEach(() => {
  currentBody = { theme: '中秋節，深藍配金色' }
  vi.mocked(recordAiUsage).mockClear()
  vi.mocked(assertMaintenanceBudget).mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => reply })))
})

describe('POST /api/richmenu/generate-background 記帳', () => {
  it('記進後台自用、帶著生圖模型：一張 1,290 個輸出 token 算出來約 US$0.039', async () => {
    reply = {
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }],
      usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 1290 },
    }
    const res = await (handler as any)({})
    expect(res.imageBase64).toBe('AAAA')

    expect(recordAiUsage).toHaveBeenCalledTimes(1)
    const [ws, delta, db] = vi.mocked(recordAiUsage).mock.calls[0]!
    expect(ws).toBe('ws1')
    expect(db).toBe(fakeDb)
    expect(delta).toEqual({
      testInputTokens: 80,
      testOutputTokens: 1290,
      testInvocations: 1,
      // 圈在後台自用那本：每月上限只數這一格（`C-414`）
      assistTokens: 80 + 1290,
      modelTokens: { test: { flashImage: { input: 80, output: 1290 } } },
    })
    const cost = bucketAiCosts(delta as never).test.costUsd
    expect(cost).toBeCloseTo(0.000024 + 0.0387, 6)
  })

  it('模型只回了字沒給圖：畫面照樣看到失敗，但那次的錢照記', async () => {
    reply = {
      candidates: [{ content: { parts: [{ text: '好的，這是一張符合您要求的底圖：' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 25 },
    }
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 502 })
    expect(vi.mocked(recordAiUsage).mock.calls[0]![1]).toMatchObject({
      testInputTokens: 80,
      testOutputTokens: 25,
      modelTokens: { test: { flashImage: { input: 80, output: 25 } } },
    })
  })

  it('⛔ 本月額度到了：擋在叫模型之前（以前生圖沒過這道守門），也就沒有錢要記', async () => {
    vi.mocked(assertMaintenanceBudget).mockRejectedValue(Object.assign(new Error('本月 AI 整理用量已達安全上限'), { statusCode: 429 }))
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 429 })
    expect(fetch).not.toHaveBeenCalled()
    expect(recordAiUsage).not.toHaveBeenCalled()
  })
})
