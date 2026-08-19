/**
 * C-45 額度收口：所有 LLM/embedding 呼叫走 gemini.ts 單一出口，
 * runWithLlmBudget 圈起來的境域內超額 → 429 擋在呼叫 Gemini 之前（一毛不花）；
 * 境域外（回答客人路徑有自己的則數額度）行為不變。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// gemini.ts 用 Nuxt 全域 useRuntimeConfig / createError；unit 環境補最小版
;(globalThis as any).useRuntimeConfig ??= () => ({ geminiApiKey: 'test-key' })
;(globalThis as any).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

const { assertMaintenanceBudget } = vi.hoisted(() => ({ assertMaintenanceBudget: vi.fn() }))
vi.mock('./ai-usage', () => ({ assertMaintenanceBudget }))

import { embedDocument, runWithLlmBudget } from './gemini'

const okEmbedding = { embedding: { values: Array.from({ length: 768 }, () => 0.1) } }

beforeEach(() => {
  assertMaintenanceBudget.mockReset()
  ;(globalThis as any).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => okEmbedding,
  }))
})

describe('runWithLlmBudget 境域守門', () => {
  it('境域內超額 → 429 擋在 fetch 之前（Gemini 一毛不花）', async () => {
    assertMaintenanceBudget.mockRejectedValue(
      Object.assign(new Error('本月 AI 整理用量已達安全上限'), { statusCode: 429 }),
    )
    await expect(runWithLlmBudget('ws1', () => embedDocument('內容')))
      .rejects.toMatchObject({ statusCode: 429 })
    expect((globalThis as any).fetch).not.toHaveBeenCalled()
  })

  it('境域內未超額 → 照常呼叫、帳照記', async () => {
    assertMaintenanceBudget.mockResolvedValue(undefined)
    const v = await runWithLlmBudget('ws1', () => embedDocument('內容'))
    expect(v).toHaveLength(768)
    expect(assertMaintenanceBudget).toHaveBeenCalledWith('ws1')
  })

  it('境域外（回答客人路徑）完全不查額度——行為不變', async () => {
    const v = await embedDocument('內容')
    expect(v).toHaveLength(768)
    expect(assertMaintenanceBudget).not.toHaveBeenCalled()
  })

  it('workspaceId 為空 → 不建立境域（保底不誤擋）', async () => {
    const v = await runWithLlmBudget('', () => embedDocument('內容'))
    expect(v).toHaveLength(768)
    expect(assertMaintenanceBudget).not.toHaveBeenCalled()
  })
})
