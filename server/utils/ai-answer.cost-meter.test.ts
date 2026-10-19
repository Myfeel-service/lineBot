/**
 * 回答客人的記帳（`C-338`②／`D-130`②）：一題裡每一次付了錢的生成呼叫都要入帳、帶著實際模型。
 *
 * 以前各終點自己把 token 一路加總：答題那次 JSON 壞掉 → 轉真人，那次的錢整筆漏掉；
 * 判意圖（flash-lite）跟答題（flash）混在一起，只能全部用大模型價格估。
 *
 * 假的 generateJson 照 gemini.ts 出口的真實行為演：回 200 就在計量器登記一筆（reportAiCall），
 * JSON 壞掉時一樣登記、再丟帶著用量的錯（gemini.cost-metering.test.ts 用假 HTTP 驗過出口真的這樣做）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimilarChunk } from './ai-knowledge-chunks'
import { reportAiCall } from './ai-usage-calls'

vi.mock('./firebase', () => ({ getDb: () => ({}) }))
vi.mock('./ai-usage', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-usage')>()),
  recordAiUsage: vi.fn(async () => {}),
  getCurrentMonthTokens: vi.fn(async () => 0),
  getQuotaAnswered: vi.fn(async () => 0),
}))
vi.mock('./billing', async importOriginal => ({
  ...(await importOriginal<typeof import('./billing')>()),
  resolveAnsweredQuota: vi.fn(async () => ({ internal: true, quota: null, periodStart: null })),
}))
vi.mock('./ai-handoff-events', () => ({ logHandoffEvent: vi.fn() }))
vi.mock('./ai-handoff-notify', () => ({ maybeWarnQuotaThreshold: vi.fn(async () => {}) }))
vi.mock('./gemini', async importOriginal => ({
  ...(await importOriginal<typeof import('./gemini')>()),
  embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
  estimateTokens: vi.fn(() => 10),
  generateJson: vi.fn(),
  generateText: vi.fn(),
}))
vi.mock('./ai-knowledge-chunks', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-knowledge-chunks')>()),
  searchSimilarChunks: vi.fn(async () => [] as SimilarChunk[]),
  searchChunksByIdentifierTag: vi.fn(async () => [] as SimilarChunk[]),
  getWorkspaceProductNames: vi.fn(async () => [] as string[]),
}))
vi.mock('./ai-knowledge-sources', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-knowledge-sources')>()),
  getCatalogSourceIds: vi.fn(async () => new Set<string>()),
}))
vi.mock('./ai-settings', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-settings')>()),
  getAiSettings: vi.fn(),
}))
vi.mock('./ai-product-alias', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-product-alias')>()),
  getProductAliases: vi.fn(async () => ({ aliases: {}, displays: {} })),
}))

const { answerWithAi, summarizeHandoffContext } = await import('./ai-answer')
const { getAiSettings, normalizeAiSettings } = await import('./ai-settings')
const { generateJson, generateText, embedQuery } = await import('./gemini')
const { searchSimilarChunks } = await import('./ai-knowledge-chunks')
const { recordAiUsage } = await import('./ai-usage')

const LITE = 'gemini-2.5-flash-lite' as const
const FLASH = 'gemini-2.5-flash' as const

/** 演 gemini.ts 出口：回 200＝登記一筆，再回結果 */
function paid<T>(model: typeof LITE | typeof FLASH, inputTokens: number, outputTokens: number, data: T) {
  reportAiCall({ model, inputTokens, outputTokens })
  return { data, inputTokens, outputTokens, model }
}
/** 演 gemini.ts 出口：回 200 但 JSON 壞掉＝登記一筆，再丟帶著用量的錯 */
function paidButBroken(model: typeof LITE | typeof FLASH, inputTokens: number, outputTokens: number): never {
  reportAiCall({ model, inputTokens, outputTokens })
  throw Object.assign(new Error('Gemini JSON parse failed: 取不到完整 JSON'), {
    statusCode: 502,
    statusMessage: 'Gemini JSON parse failed: 取不到完整 JSON',
    aiUsage: { model, inputTokens, outputTokens },
  })
}

const intentJson = (q: string) => ({ intent: 'question', isFollowup: false, standaloneQuery: q, compareItems: [], subQuestions: [] })

function deltas() {
  return vi.mocked(recordAiUsage).mock.calls.map(c => c[1])
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAiSettings).mockResolvedValue(normalizeAiSettings({ enabled: true, systemPrompt: '你是客服', shopUrl: '' }))
  vi.mocked(embedQuery).mockResolvedValue([0.1, 0.2, 0.3])
  vi.mocked(searchSimilarChunks).mockResolvedValue([
    { id: 'c1', title: '保固', content: '保固一年。', tags: [], similarity: 0.95, sourceId: 's1', isOverview: false } as SimilarChunk,
  ])
})

describe('answerWithAi 記帳', () => {
  it('⛔ 答題那次 JSON 壞掉 → 轉真人，但那次的錢照記（以前整筆漏掉），而且判意圖照 lite、答題照 flash 分開記', async () => {
    vi.mocked(generateJson)
      .mockImplementationOnce(async () => paid(LITE, 40, 8, intentJson('保固多久')))
      .mockImplementationOnce(async () => paidButBroken(FLASH, 1500, 300))

    const res = await answerWithAi({ workspaceId: 'ws1', query: '保固多久' })
    expect(res.decision).toBe('handoff')
    expect(res.handoffReason).toBe('llm_error')

    expect(deltas()).toHaveLength(1)
    expect(deltas()[0]).toMatchObject({
      invocations: 1,
      handoffs: 1,
      inputTokens: 1540,
      outputTokens: 308,
      modelTokens: { conversation: { flashLite: { input: 40, output: 8 }, flash: { input: 1500, output: 300 } } },
    })
    expect(deltas()[0]!.billable).toBeUndefined() // 轉真人不扣則數（計費完全沒動）
  })

  it('正常答出：一筆、兩顆模型各記各的，計費則數照舊', async () => {
    vi.mocked(generateJson)
      .mockImplementationOnce(async () => paid(LITE, 40, 8, intentJson('保固多久')))
      .mockImplementationOnce(async () => paid(FLASH, 1500, 60, { answer: '保固一年喔。', hasInfo: true }))

    const res = await answerWithAi({ workspaceId: 'ws1', query: '保固多久' })
    expect(res.decision).toBe('answered')
    expect(deltas()).toEqual([expect.objectContaining({
      invocations: 1,
      answered: 1,
      billable: 1,
      embeddingTokens: 10,
      inputTokens: 1540,
      outputTokens: 68,
      modelTokens: { conversation: { flashLite: { input: 40, output: 8 }, flash: { input: 1500, output: 60 } } },
    })])
  })

  it('試打（isTest）：整筆記到後台自用，客人那桶一個 token 都不碰', async () => {
    vi.mocked(generateJson)
      .mockImplementationOnce(async () => paid(LITE, 40, 8, intentJson('保固多久')))
      .mockImplementationOnce(async () => paid(FLASH, 1500, 60, { answer: '保固一年喔。', hasInfo: true }))

    await answerWithAi({ workspaceId: 'ws1', query: '保固多久', isTest: true })
    const d = deltas()[0]!
    expect(d).toMatchObject({
      testInvocations: 1,
      testInputTokens: 1540,
      testOutputTokens: 68,
      testEmbeddingTokens: 10,
      modelTokens: { test: { flashLite: { input: 40, output: 8 }, flash: { input: 1500, output: 60 } } },
    })
    expect(d.inputTokens).toBeUndefined()
    expect(d.invocations).toBeUndefined()
    expect(d.billable).toBeUndefined()
  })

  it('路由在 handler 先跑過（precomputedIntent）：這一題只記答題那次，不重複算路由', async () => {
    vi.mocked(generateJson)
      .mockImplementationOnce(async () => paid(FLASH, 1500, 60, { answer: '保固一年喔。', hasInfo: true }))

    await answerWithAi({
      workspaceId: 'ws1',
      query: '保固多久',
      precomputedIntent: { ...intentJson('保固多久'), intent: 'question', inputTokens: 40, outputTokens: 8 } as any,
    })
    expect(deltas()[0]).toMatchObject({ inputTokens: 1500, outputTokens: 60, modelTokens: { conversation: { flash: { input: 1500, output: 60 } } } })
  })

  it('轉向量先失敗、判意圖還在跑：等它回來再入帳，那次的錢不會漏', async () => {
    vi.mocked(embedQuery).mockRejectedValueOnce(new Error('embed 503'))
    vi.mocked(generateJson).mockImplementationOnce(async () => {
      await new Promise(r => setTimeout(r, 20))
      return paid(LITE, 40, 8, intentJson('保固多久'))
    })
    const res = await answerWithAi({ workspaceId: 'ws1', query: '保固多久' })
    expect(res.handoffReason).toBe('llm_error')
    expect(deltas()).toEqual([expect.objectContaining({
      invocations: 1,
      handoffs: 1,
      inputTokens: 40,
      outputTokens: 8,
      modelTokens: { conversation: { flashLite: { input: 40, output: 8 } } },
    })])
  })
})

describe('轉真人交接摘要（以前完全沒記帳，`C-338`①）', () => {
  const history = [{ role: 'user' as const, text: '我的訂單還沒到' }, { role: 'bot' as const, text: '幫您查一下' }]

  it('記進回答客人那桶、照 flash-lite 價；⛔ 不記次數（答出＋反問＋轉真人＝總數那條不能被打破）', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: '客人在問訂單進度。', inputTokens: 120, outputTokens: 30, model: LITE })
    const text = await summarizeHandoffContext(history, '', null, { workspaceId: 'ws1' })
    expect(text).toBe('客人在問訂單進度。')
    expect(recordAiUsage).toHaveBeenCalledWith('ws1', {
      inputTokens: 120,
      outputTokens: 30,
      modelTokens: { conversation: { flashLite: { input: 120, output: 30 } } },
    }, undefined)
  })

  it('摘要逾時放棄等它：回來時錢照記（記帳掛在呼叫本身，不是掛在等的那一邊）', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(generateText).mockImplementationOnce(() => new Promise(r => setTimeout(() => r({ text: '晚到的摘要', inputTokens: 100, outputTokens: 20, model: LITE }), 6000)))
      const p = summarizeHandoffContext(history, '', null, { workspaceId: 'ws1' })
      await vi.advanceTimersByTimeAsync(4000)
      await expect(p).resolves.toBe('') // 逾時：不拖累轉真人
      expect(recordAiUsage).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2000)
      expect(recordAiUsage).toHaveBeenCalledWith('ws1', expect.objectContaining({ inputTokens: 100, outputTokens: 20 }), undefined)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('沒帶工作區（舊呼叫法）就不記，行為跟以前一樣', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: '摘要', inputTokens: 1, outputTokens: 1, model: LITE })
    await summarizeHandoffContext(history, '')
    expect(recordAiUsage).not.toHaveBeenCalled()
  })
})
