import { describe, expect, it, vi } from 'vitest'

/**
 * 小幫手一句話的記帳（`C-338`②／`D-130`②）：記進後台自用、次數一起記，
 * token 照「每一輪實際用的模型」記——包括格式壞掉重來前那一次（runAdminAgentChat 回的 calls）。
 */

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) } }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: 'ws1', uid: 'u1', role: 'admin' })),
}))
vi.mock('~~/server/utils/ai-admin-agent', () => ({ runAdminAgentChat: vi.fn() }))
vi.mock('~~/server/utils/ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/gemini', () => ({ runWithLlmBudget: (_ws: string, fn: () => Promise<unknown>) => fn() }))
vi.mock('~~/server/utils/agent-rate-limit', () => ({ hitAgentRateLimit: () => ({ limited: false, retryAfterMs: 0 }) }))
vi.mock('~~/server/utils/admin-op-token', () => ({ verifyAdminOpToken: () => null }))
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => ({ collection: () => ({ add: async () => {} }) }) }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => ({ message: '這個月 AI 花了多少' }))
vi.stubGlobal('getHeader', () => 'Bearer x')
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./chat.post')
const { runAdminAgentChat } = await import('~~/server/utils/ai-admin-agent')
const { recordAiUsage } = await import('~~/server/utils/ai-usage')

describe('POST /api/admin/agent/chat 記帳', () => {
  it('每一輪照實際模型記進後台自用（含格式壞掉那次），次數記一次', async () => {
    vi.mocked(runAdminAgentChat).mockResolvedValueOnce({
      reply: '這個月花了 NT$3。',
      toolCalls: [],
      messages: [],
      inputTokens: 3500,
      outputTokens: 600,
      calls: [
        { model: 'gemini-2.5-flash', inputTokens: 3000, outputTokens: 500 }, // 格式壞掉、重來前那次
        { model: 'gemini-2.5-flash-lite', inputTokens: 500, outputTokens: 100 }, // 塞車改 lite 的那次
      ],
    } as any)
    await (handler as any)({})
    expect(recordAiUsage).toHaveBeenCalledWith('ws1', {
      testInputTokens: 3500,
      testOutputTokens: 600,
      testInvocations: 1,
      // 圈在後台自用那本：每月上限只數這一格（`C-414`）
      assistTokens: 3500 + 600,
      modelTokens: { test: { flash: { input: 3000, output: 500 }, flashLite: { input: 500, output: 100 } } },
    })
  })
})
