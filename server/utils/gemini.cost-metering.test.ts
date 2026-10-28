/**
 * gemini.ts 出口的記帳資訊（`D-130`②／`C-338`）：打假的 Gemini HTTP，不碰真的服務。
 *
 *   ① 每次回 200 都帶上「實際用的模型」——flash 塞車自動改 lite 那次要說是 lite
 *   ② JSON 壞掉時錢已經付了：丟出去的錯誤帶著用量、計量器也收得到
 *   ③ 思考 token 照輸出價收：要加進輸出
 *   ④ 生圖：回傳生圖模型、計量器收得到；只回字沒給圖那次也帶用量；⛔ 有過額度守門
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).useRuntimeConfig ??= () => ({ geminiApiKey: 'test-key' })
;(globalThis as any).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

const { assertMaintenanceBudget } = vi.hoisted(() => ({ assertMaintenanceBudget: vi.fn() }))
vi.mock('./ai-usage', () => ({ assertMaintenanceBudget }))

import { generateImage, generateJson, generateText, runWithLlmBudget } from './gemini'
import { aiUsageOfError, withAiCallMeter, type AiCallUsage } from './ai-usage-calls'

type Reply = { status?: number; body: unknown }
let replies: Reply[] = []
const calledModels: string[] = []

function textReply(text: string, usage: Record<string, number>): Reply {
  return { body: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: usage } }
}

beforeEach(() => {
  replies = []
  calledModels.length = 0
  assertMaintenanceBudget.mockReset()
  ;(globalThis as any).fetch = vi.fn(async (url: string) => {
    calledModels.push(String(url).match(/models\/([^:]+):/)?.[1] ?? '')
    const r = replies.shift() ?? { status: 500, body: { error: { message: 'no more replies' } } }
    const status = r.status ?? 200
    return { ok: status < 400, status, json: async () => r.body }
  })
})

describe('① 回傳實際用的模型', () => {
  it('指定 flash-lite 就是 lite', async () => {
    replies.push(textReply('好', { promptTokenCount: 50, candidatesTokenCount: 3 }))
    const r = await generateText('hi', { model: 'gemini-2.5-flash-lite', thinkingBudget: 0 })
    expect(r).toMatchObject({ model: 'gemini-2.5-flash-lite', inputTokens: 50, outputTokens: 3 })
  })

  it('flash 塞車（重試後仍 503）自動改 lite：記帳要照 lite（那次是照 lite 收錢的）', async () => {
    replies.push({ status: 503, body: { error: { message: 'overloaded' } } })
    replies.push({ status: 503, body: { error: { message: 'overloaded' } } })
    replies.push(textReply('好', { promptTokenCount: 80, candidatesTokenCount: 4 }))
    const meter: AiCallUsage[] = []
    const r = await withAiCallMeter(meter, () => generateText('hi'))
    expect(calledModels).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'])
    expect(r.model).toBe('gemini-2.5-flash-lite')
    // 503 那兩次沒有收錢（沒有 usage），計量器只收到真的付了錢的那一次
    expect(meter).toEqual([{ model: 'gemini-2.5-flash-lite', inputTokens: 80, outputTokens: 4 }])
  })
})

describe('② JSON 壞掉那次也付了錢', () => {
  it('丟出去的錯誤帶著用量；計量器也收到', async () => {
    replies.push(textReply('{"answer": "被截斷', { promptTokenCount: 1200, candidatesTokenCount: 300 }))
    const meter: AiCallUsage[] = []
    const err = await withAiCallMeter(meter, () => generateJson('q', { model: 'gemini-2.5-flash' })).catch(e => e)
    expect(String(err?.statusMessage)).toContain('JSON parse failed')
    expect(aiUsageOfError(err)).toEqual({ model: 'gemini-2.5-flash', inputTokens: 1200, outputTokens: 300 })
    expect(meter).toEqual([{ model: 'gemini-2.5-flash', inputTokens: 1200, outputTokens: 300 }])
  })

  it('JSON 正常時回傳模型', async () => {
    replies.push(textReply('{"ok":true}', { promptTokenCount: 10, candidatesTokenCount: 2 }))
    await expect(generateJson('q', { model: 'gemini-2.5-flash-lite' })).resolves.toMatchObject({ data: { ok: true }, model: 'gemini-2.5-flash-lite' })
  })
})

describe('③ 思考 token 照輸出價收', () => {
  it('thoughtsTokenCount 加進輸出（以前只讀 candidatesTokenCount）', async () => {
    replies.push(textReply('好', { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 200 }))
    const r = await generateText('hi')
    expect(r.outputTokens).toBe(205)
  })
})

describe('④ 生圖', () => {
  const imageReply = (usage: Record<string, number>): Reply => ({
    body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }], usageMetadata: usage },
  })

  it('回傳生圖模型、計量器收得到（輸出那 1,290 個 token 是照生圖價收的）', async () => {
    replies.push(imageReply({ promptTokenCount: 60, candidatesTokenCount: 1290 }))
    const meter: AiCallUsage[] = []
    const img = await withAiCallMeter(meter, () => generateImage('a banner'))
    expect(img).toMatchObject({ model: 'gemini-2.5-flash-image', inputTokens: 60, outputTokens: 1290 })
    expect(meter).toEqual([{ model: 'gemini-2.5-flash-image', inputTokens: 60, outputTokens: 1290 }])
  })

  it('模型只回字、沒給圖：錯誤照丟，但帶著那次的用量', async () => {
    replies.push(textReply('好的，這是一張符合您要求的底圖：', { promptTokenCount: 60, candidatesTokenCount: 20 }))
    const err = await generateImage('a banner').catch(e => e)
    expect(String(err?.statusMessage)).toContain('產生底圖失敗')
    expect(aiUsageOfError(err)).toEqual({ model: 'gemini-2.5-flash-image', inputTokens: 60, outputTokens: 20 })
  })

  it('⛔ 圈在額度境域裡、超額時擋在呼叫之前（以前生圖沒過守門，包了等於沒包）', async () => {
    assertMaintenanceBudget.mockRejectedValue(Object.assign(new Error('本月 AI 整理用量已達安全上限'), { statusCode: 429 }))
    await expect(runWithLlmBudget('ws1', () => generateImage('a banner'), 'assist')).rejects.toMatchObject({ statusCode: 429 })
    expect((globalThis as any).fetch).not.toHaveBeenCalled()
    expect(assertMaintenanceBudget).toHaveBeenCalledWith('ws1', undefined, 'assist')
  })
})
