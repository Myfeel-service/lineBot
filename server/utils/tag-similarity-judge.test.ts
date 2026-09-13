/**
 * 標籤名「像不像」第二層：LLM 判官（`C-178`）。
 *
 * 釘住的是這支唯一會造成**實害**的失敗模式——**判決錯位**：
 * 模型少回一組、或 index 亂給，若讓結果往前遞補，就會把 A 組的判決套到 B 組身上，
 * 畫面上變成指著一顆毫不相干的標籤說「這是同一件事」，而人會照著它去併標籤。
 * 所以這裡的預設值永遠是 `unsure`（＝不出聲），不是「往前補」。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./gemini', () => ({
  generateJson: vi.fn(),
  runWithLlmBudget: (_ws: string, fn: () => Promise<unknown>) => fn(),
}))

;(globalThis as any).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

const { buildJudgePrompt, judgeSimilarTagNames, parseJudgeVerdicts } = await import('./tag-similarity-judge')
const { generateJson } = await import('./gemini')

const PAIRS = [
  { candidate: '在看無線麥克風', existing: '在看收音麥克風' },
  { candidate: '在看錄音麥克風', existing: '在看 AI 錄音耳機' },
]

describe('判決對回原本那一組', () => {
  it('照 index 對回去，不是照回傳順序', () => {
    const out = parseJudgeVerdicts({
      results: [
        { index: 1, verdict: 'different', reason: '一個是麥克風一個是耳機' },
        { index: 0, verdict: 'same', reason: '兩顆都是在看麥克風' },
      ],
    }, 2)
    expect(out[0]).toEqual({ verdict: 'same', reason: '兩顆都是在看麥克風' })
    expect(out[1]).toEqual({ verdict: 'different', reason: '一個是麥克風一個是耳機' })
  })

  /**
   * ⛔ 少回的那組要維持 unsure（不出聲），**不可以**讓後面的往前遞補——
   * 那會把「錄音麥克風 vs 錄音耳機」的判決貼到「無線麥克風 vs 收音麥克風」頭上。
   */
  it('模型少回一組 → 那一組維持 unsure，不往前遞補', () => {
    const out = parseJudgeVerdicts({ results: [{ index: 1, verdict: 'same', reason: 'x' }] }, 2)
    expect(out[0]?.verdict).toBe('unsure')
    expect(out[1]?.verdict).toBe('same')
  })

  it('index 超出範圍 / 不是數字 → 整筆丟掉，長度仍等於組數', () => {
    const out = parseJudgeVerdicts({
      results: [
        { index: 9, verdict: 'same', reason: 'x' },
        { index: 'a', verdict: 'same', reason: 'x' },
      ],
    }, 2)
    expect(out).toHaveLength(2)
    expect(out.every(o => o.verdict === 'unsure')).toBe(true)
  })

  /** ⛔ 模型偶爾會發明 "maybe"、"likely"——當成 same 就是誤報 */
  it('白名單外的 verdict 一律當 unsure', () => {
    const out = parseJudgeVerdicts({ results: [{ index: 0, verdict: 'maybe', reason: 'x' }] }, 1)
    expect(out[0]?.verdict).toBe('unsure')
  })

  it('模型整個沒回 results → 全部 unsure，不會炸', () => {
    expect(parseJudgeVerdicts({}, 2)).toEqual([
      { verdict: 'unsure', reason: '' },
      { verdict: 'unsure', reason: '' },
    ])
  })
})

describe('prompt', () => {
  it('把兩邊的名字與判斷條件都寫進去（光看名字分不出麥克風和耳機）', () => {
    const p = buildJudgePrompt([{
      candidate: '在看錄音麥克風',
      candidateCriteria: '詢問錄音麥克風的連線、轉文字',
      existing: '在看 AI 錄音耳機',
      existingCriteria: '詢問 AI 錄音耳機',
    }])
    expect(p).toContain('在看錄音麥克風')
    expect(p).toContain('詢問錄音麥克風的連線、轉文字')
    expect(p).toContain('在看 AI 錄音耳機')
    expect(p).toContain('詢問 AI 錄音耳機')
  })

  it('沒有判斷條件的標籤不會印出空的「判斷條件：」', () => {
    expect(buildJudgePrompt([PAIRS[0]!])).not.toContain('判斷條件：\n')
  })
})

describe('呼叫端拿到什麼', () => {
  it('零組配對不打 LLM（別為了問空問題燒額度）', async () => {
    const res = await judgeSimilarTagNames('ws1', [])
    expect(res).toEqual({ verdicts: [], inputTokens: 0, outputTokens: 0 })
    expect(generateJson).not.toHaveBeenCalled()
  })

  /**
   * ⛔ 失敗要回 null，**不可以**退化成「全部 different」——那是一句假的否定：
   * 我們根本沒問到。呼叫端要靠這個 null 把「查過沒有」跟「沒查過」分開存。
   */
  it('模型爆掉 → 回 null（不是「全部沒有重複」）', async () => {
    vi.mocked(generateJson).mockRejectedValueOnce(new Error('budget exhausted'))
    expect(await judgeSimilarTagNames('ws1', PAIRS)).toBeNull()
  })

  it('成功時把 token 一起回去（掃描要記帳）', async () => {
    vi.mocked(generateJson).mockResolvedValueOnce({
      data: { results: [{ index: 0, verdict: 'same', reason: '都是麥克風' }] },
      inputTokens: 120,
      outputTokens: 30,
    } as any)
    const res = await judgeSimilarTagNames('ws1', PAIRS)
    expect(res?.inputTokens).toBe(120)
    expect(res?.verdicts[0]?.verdict).toBe('same')
    expect(res?.verdicts[1]?.verdict).toBe('unsure') // 沒回到的那組不出聲
  })
})
