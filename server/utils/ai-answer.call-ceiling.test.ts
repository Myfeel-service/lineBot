/**
 * AI 呼叫上限（`C-8`，老闆 2026-10-20「照建議」）：答不出來不扣則＝答不出來的呼叫永遠燒不完額度、成本沒有上限。
 * 這個月 AI 被叫的次數到了則數額度的 10 倍，就跟則數用完走同一條路：客人收到真人客服那句（quota_exceeded），
 * 給店家的 LINE 通知講「被叫太多次、大多答不出來」，不是「額度用完」。
 *
 * 另釘：客人傳照片那條（isReplyQuotaExhausted）對同一個帳號的答案跟文字這條一樣。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimilarChunk } from './ai-knowledge-chunks'

vi.mock('./firebase', () => ({ getDb: () => ({}) }))

vi.mock('./ai-usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai-usage')>()),
  recordAiUsage: vi.fn(async () => {}),
  getCurrentMonthTokens: vi.fn(async () => 0),
  getQuotaAnswered: vi.fn(async () => 0),
  getCurrentMonthAiCalls: vi.fn(async () => 0),
}))

vi.mock('./billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing')>()),
  resolveAnsweredQuota: vi.fn(),
}))

vi.mock('./ai-handoff-events', () => ({ logHandoffEvent: vi.fn() }))
vi.mock('./ai-handoff-notify', async (importOriginal) => ({
  aiCallCeilingNotifyKey: (await importOriginal<typeof import('./ai-handoff-notify')>()).aiCallCeilingNotifyKey,
  maybeWarnQuotaThreshold: vi.fn(async () => {}),
  maybeNotifyQuotaExhausted: vi.fn(async () => {}),
}))

vi.mock('./gemini', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gemini')>()),
  embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
  estimateTokens: vi.fn(() => 10),
  generateJson: vi.fn(async () => ({ data: { answer: '（不該被呼叫）', hasInfo: false }, inputTokens: 0, outputTokens: 0 })),
  generateText: vi.fn(),
}))

vi.mock('./ai-knowledge-chunks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai-knowledge-chunks')>()),
  searchSimilarChunks: vi.fn(async () => [] as SimilarChunk[]),
  searchChunksByIdentifierTag: vi.fn(async () => [] as SimilarChunk[]),
  getWorkspaceProductNames: vi.fn(async () => [] as string[]),
}))

vi.mock('./ai-knowledge-sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai-knowledge-sources')>()),
  getCatalogSourceIds: vi.fn(async () => new Set<string>()),
}))

vi.mock('./ai-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai-settings')>()),
  getAiSettings: vi.fn(),
}))

vi.mock('./ai-product-alias', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai-product-alias')>()),
  getProductAliases: vi.fn(async () => ({ aliases: {}, displays: {} })),
}))

const { answerWithAi } = await import('./ai-answer')
const { isReplyQuotaExhausted } = await import('./reply-quota')
const { getAiSettings, normalizeAiSettings } = await import('./ai-settings')
const { resolveAnsweredQuota } = await import('./billing')
const { getQuotaAnswered, getCurrentMonthAiCalls, recordAiUsage } = await import('./ai-usage')
const { maybeWarnQuotaThreshold, maybeNotifyQuotaExhausted } = await import('./ai-handoff-notify')
const { taipeiYyyyMm } = await import('~~/shared/time')

function ask() {
  return answerWithAi({
    workspaceId: 'ws1',
    query: '運費多少',
    precomputedIntent: {
      intent: 'question',
      isFollowup: false,
      standaloneQuery: '運費多少',
      compareItems: [],
      subQuestions: [],
      inputTokens: 0,
      outputTokens: 0,
    } as any,
  })
}

/** 等 fire-and-forget 的通知呼叫跑完 */
const flush = () => new Promise(r => setTimeout(r, 0))

/** 輕量方案 200 則、本期才用 12 則（則數離用完很遠） */
const LITE = { internal: false, quota: 200, planId: 'lite' as const, periodStart: '2026-10-01' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAiSettings).mockResolvedValue(normalizeAiSettings({
    enabled: true,
    systemPrompt: '你是客服',
    shopUrl: '',
    quota: { monthlyTokenCap: 1_000_000, onExceed: 'handoff_all' },
  }))
  vi.mocked(resolveAnsweredQuota).mockResolvedValue(LITE)
  vi.mocked(getQuotaAnswered).mockResolvedValue(12)
  vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(0)
})

describe('文字訊息：這個月 AI 被叫的次數 vs 則數額度 × 10', () => {
  it('被叫 9 倍 → 照常答，不停、不推「停了」', async () => {
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(1_800)
    const out = await ask()
    await flush()
    expect(out.handoffReason).not.toBe('quota_exceeded')
    expect(vi.mocked(maybeNotifyQuotaExhausted)).not.toHaveBeenCalled()
  })

  it('🔴 被叫到 10 倍 → 跟則數用完同一條路（quota_exceeded），不叫 LLM', async () => {
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(2_000)
    const { generateJson, embedQuery } = await import('./gemini')
    const out = await ask()
    expect(out.decision).toBe('handoff')
    expect(out.handoffReason).toBe('quota_exceeded')
    expect(vi.mocked(embedQuery)).not.toHaveBeenCalled()
    expect(vi.mocked(generateJson)).not.toHaveBeenCalled()
  })

  it('🔴 被擋下的那次記 quotaBlocked（AI 沒出手），不扣則', async () => {
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(2_000)
    await ask()
    const delta = vi.mocked(recordAiUsage).mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(delta).toMatchObject({ invocations: 1, handoffs: 1, quotaBlocked: 1 })
    expect(delta.billable).toBeUndefined()
  })

  it('🔴 推給店家的那則講「被叫太多次、大多答不出來」，期別是這個台北月（一個月一則）', async () => {
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(2_345)
    await ask()
    await flush()
    const arg = vi.mocked(maybeNotifyQuotaExhausted).mock.calls[0]?.[0] as any
    expect(arg.cause).toBe('calls')
    expect(arg.action).toBe('handoff')
    expect(arg.periodKey).toBe(`c_${taipeiYyyyMm()}`)
    expect(arg.usageText).toBe('這個月 AI 被叫了 2345 次、大多答不出來(上限 2000 次)')
    // ⛔ 不接「則數快用完」的預警：AI 已經停了
    expect(vi.mocked(maybeWarnQuotaThreshold)).not.toHaveBeenCalled()
  })

  it('則數也用完了 → 講「則數用完」那則（不是呼叫太多）', async () => {
    vi.mocked(getQuotaAnswered).mockResolvedValue(200)
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(5_000)
    await ask()
    await flush()
    const arg = vi.mocked(maybeNotifyQuotaExhausted).mock.calls[0]?.[0] as any
    expect(arg.cause ?? 'replies').toBe('replies')
    expect(arg.usageText).toBe('本期 AI 回覆則數 200/200')
  })

  it('內部方案：被叫再多都照常答', async () => {
    vi.mocked(resolveAnsweredQuota).mockResolvedValue({ internal: true, quota: null, planId: 'internal', periodStart: null })
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(10_000_000)
    const out = await ask()
    expect(out.handoffReason).not.toBe('quota_exceeded')
  })

  it('不限則數（企業沒設額度）：這條不套，只剩 token 護欄', async () => {
    vi.mocked(resolveAnsweredQuota).mockResolvedValue({ internal: false, quota: null, planId: 'enterprise', periodStart: null })
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(10_000_000)
    const out = await ask()
    expect(out.handoffReason).not.toBe('quota_exceeded')
  })

  it('playground 測試不受這條擋', async () => {
    vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(10_000_000)
    const out = await answerWithAi({ workspaceId: 'ws1', query: '運費多少', isTest: true } as any)
    expect(out.handoffReason).not.toBe('quota_exceeded')
  })
})

describe('客人傳照片那條（isReplyQuotaExhausted）跟文字這條同一把尺', () => {
  const cases: Array<{ name: string, billing: any, answered: number, calls: number }> = [
    { name: '9 倍', billing: LITE, answered: 12, calls: 1_800 },
    { name: '10 倍', billing: LITE, answered: 12, calls: 2_000 },
    { name: '則數用完', billing: LITE, answered: 200, calls: 0 },
    { name: '內部方案被叫一千萬次', billing: { internal: true, quota: null, planId: 'internal', periodStart: null }, answered: 0, calls: 10_000_000 },
    { name: '企業沒設額度被叫一千萬次', billing: { internal: false, quota: null, planId: 'enterprise', periodStart: null }, answered: 0, calls: 10_000_000 },
  ]
  for (const c of cases) {
    it(`${c.name}：兩條路答案一樣`, async () => {
      vi.mocked(resolveAnsweredQuota).mockResolvedValue(c.billing)
      vi.mocked(getQuotaAnswered).mockResolvedValue(c.answered)
      vi.mocked(getCurrentMonthAiCalls).mockResolvedValue(c.calls)
      const textStopped = (await ask()).handoffReason === 'quota_exceeded'
      const photoStopped = await isReplyQuotaExhausted('ws1')
      expect(photoStopped).toBe(textStopped)
    })
  }
})
