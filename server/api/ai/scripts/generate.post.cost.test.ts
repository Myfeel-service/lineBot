import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reportAiCall } from '~~/server/utils/ai-usage-calls'

/**
 * 一句話生成自動回應的記帳（`C-338`②）：第一次沒過會再生一次，兩次都沒過丟 422——
 * 以前丟錯時兩次的錢都沒記。現在記進後台自用、照實際模型、次數一起記。
 */

vi.mock('~~/server/utils/workspace-auth', () => ({ requireCapability: vi.fn(async () => ({ workspaceId: 'ws1' })) }))
vi.mock('~~/server/utils/ai-script-generate', () => ({ generateScriptDraft: vi.fn() }))
vi.mock('~~/server/utils/ai-settings', () => ({ getAiSettings: vi.fn(async () => ({ sensitiveTopics: [] })) }))
vi.mock('~~/server/utils/ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/billing', () => ({ assertPlanAllows: vi.fn(async () => {}) }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => ({ description: '客人要退貨時先問訂單編號再問原因' }))

const { default: handler } = await import('./generate.post')
const { generateScriptDraft } = await import('~~/server/utils/ai-script-generate')
const { recordAiUsage } = await import('~~/server/utils/ai-usage')

const FLASH = 'gemini-2.5-flash'

beforeEach(() => vi.mocked(recordAiUsage).mockClear())

describe('POST /api/ai/scripts/generate 記帳', () => {
  it('生成成功：兩次（重生那次也算）照模型記進後台自用，次數一次', async () => {
    vi.mocked(generateScriptDraft).mockImplementationOnce(async () => {
      reportAiCall({ model: FLASH, inputTokens: 2000, outputTokens: 1500 })
      reportAiCall({ model: FLASH, inputTokens: 2100, outputTokens: 1600 })
      return { name: '退貨', nodes: [], rootNodeId: 'n1', inputTokens: 4100, outputTokens: 3100 }
    })
    await (handler as any)({})
    expect(recordAiUsage).toHaveBeenCalledWith('ws1', {
      testInputTokens: 4100,
      testOutputTokens: 3100,
      testInvocations: 1,
      modelTokens: { test: { flash: { input: 4100, output: 3100 } } },
    })
  })

  it('⛔ 兩次都沒生好丟 422：畫面照樣看到錯誤，但兩次的錢照記', async () => {
    vi.mocked(generateScriptDraft).mockImplementationOnce(async () => {
      reportAiCall({ model: FLASH, inputTokens: 2000, outputTokens: 1500 })
      reportAiCall({ model: FLASH, inputTokens: 2100, outputTokens: 1600 })
      throw Object.assign(new Error('AI 這次沒生好'), { statusCode: 422 })
    })
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 422 })
    expect(recordAiUsage).toHaveBeenCalledWith('ws1', expect.objectContaining({ testInputTokens: 4100, testOutputTokens: 3100, testInvocations: 1 }))
  })
})
