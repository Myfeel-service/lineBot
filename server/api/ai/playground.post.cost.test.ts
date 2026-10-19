import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reportAiCall } from '~~/server/utils/ai-usage-calls'

/**
 * 設定頁「試打 AI」的意圖路由記帳（`C-338`②／`D-130`②）：記進後台自用、照 flash-lite 的價；
 * 路由回的 JSON 壞掉（routeMessage 回 null）那次也付了錢——以前只有路由成功才記。
 */

vi.mock('~~/server/utils/workspace-auth', () => ({ requireCapability: vi.fn(async () => ({ workspaceId: 'ws1' })) }))
vi.mock('~~/server/utils/ai-answer', () => ({ answerWithAi: vi.fn(async () => ({ decision: 'answered' })), routeMessage: vi.fn() }))
vi.mock('~~/server/utils/ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-scripts', () => ({
  loadActiveScripts: vi.fn(async () => [
    { id: 's1', name: '退換貨', enabled: true, rootNodeId: 'n1', nodes: [{ id: 'n1', type: 'trigger', keywords: ['退貨'] }] },
  ]),
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => ({ query: '請問有開發票嗎' }))
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./playground.post')
const { routeMessage } = await import('~~/server/utils/ai-answer')
const { recordAiUsage } = await import('~~/server/utils/ai-usage')

beforeEach(() => vi.mocked(recordAiUsage).mockClear())

describe('POST /api/ai/playground 路由記帳', () => {
  it('路由那次記進後台自用、照 flash-lite 價', async () => {
    vi.mocked(routeMessage).mockImplementationOnce(async () => {
      reportAiCall({ model: 'gemini-2.5-flash-lite', inputTokens: 300, outputTokens: 30 })
      return { intent: 'question', scriptId: null } as any
    })
    await (handler as any)({})
    expect(recordAiUsage).toHaveBeenCalledWith('ws1', {
      testInputTokens: 300,
      testOutputTokens: 30,
      modelTokens: { test: { flashLite: { input: 300, output: 30 } } },
    })
  })

  it('⛔ 路由回 null（JSON 壞掉）那次也照記', async () => {
    vi.mocked(routeMessage).mockImplementationOnce(async () => {
      reportAiCall({ model: 'gemini-2.5-flash-lite', inputTokens: 300, outputTokens: 400 })
      return null
    })
    await (handler as any)({})
    expect(recordAiUsage).toHaveBeenCalledWith('ws1', expect.objectContaining({ testInputTokens: 300, testOutputTokens: 400 }))
  })
})
