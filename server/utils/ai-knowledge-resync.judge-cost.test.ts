/**
 * 「只改措辭」判官（judgeCosmeticRewrites）的用量（`C-338`②）：
 * 一批 JSON 壞掉時那批留在「沒判到」照舊給人看——但那批的錢已經付了，要帶回去給呼叫端記帳。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./gemini', () => ({ generateJson: vi.fn() }))
vi.mock('./firebase', () => ({ getDb: () => ({}) }))

const { judgeCosmeticRewrites, COSMETIC_JUDGE_BATCH } = await import('./ai-knowledge-resync')
const { generateJson } = await import('./gemini')

const pair = (i: number) => ({ oldTitle: `卡${i}`, old: `舊${i}`, nextTitle: `卡${i}`, next: `新${i}` })

describe('judgeCosmeticRewrites 用量', () => {
  it('成功那批照模型記、壞掉那批的錢也帶回去（兩批都在 calls 裡）', async () => {
    vi.mocked(generateJson)
      .mockResolvedValueOnce({ data: { results: [{ index: 0, verdict: 'same_meaning' }] }, inputTokens: 800, outputTokens: 60, model: 'gemini-2.5-flash' })
      .mockRejectedValueOnce(Object.assign(new Error('Gemini JSON parse failed'), { aiUsage: { model: 'gemini-2.5-flash', inputTokens: 900, outputTokens: 2048 } }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pairs = Array.from({ length: COSMETIC_JUDGE_BATCH + 1 }, (_, i) => pair(i))
    const res = await judgeCosmeticRewrites(pairs)
    warn.mockRestore()

    expect(res.verdicts[0]).toBe('same_meaning')
    expect(res.verdicts[COSMETIC_JUDGE_BATCH]).toBe('unsure') // 壞掉那批照舊給人看
    expect(res.inputTokens).toBe(1700)
    expect(res.outputTokens).toBe(2108)
    expect(res.calls).toEqual([
      { model: 'gemini-2.5-flash', inputTokens: 800, outputTokens: 60 },
      { model: 'gemini-2.5-flash', inputTokens: 900, outputTokens: 2048 },
    ])
  })
})
