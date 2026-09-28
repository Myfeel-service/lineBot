/**
 * 額度預警推給店家的那句話不報 token 數字（`G-103`）。
 *
 * 沒有則數額度的帳號（企業客製未設額度、或讀不到訂閱）只剩 token 上限當煞車。
 * 原本推到 LINE 的是「本月 AI token 用量 850,000/1,000,000」——通知名單上客服也在，
 * token 卻是平台的進貨單位、畫面上只有超管看得到用量。
 * 🔴 改講「接近／已達『AI 設定』裡的上限」；有則數額度的帳號照舊報則數（那是他買的單位）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimilarChunk } from './ai-knowledge-chunks'

vi.mock('./firebase', () => ({ getDb: () => ({}) }))

vi.mock('./ai-usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai-usage')>()),
  recordAiUsage: vi.fn(async () => {}),
  getCurrentMonthTokens: vi.fn(async () => 0),
  getQuotaAnswered: vi.fn(async () => 0),
}))

vi.mock('./billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing')>()),
  resolveAnsweredQuota: vi.fn(),
}))

vi.mock('./ai-handoff-events', () => ({ logHandoffEvent: vi.fn() }))
vi.mock('./ai-handoff-notify', () => ({
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
const { getAiSettings, normalizeAiSettings } = await import('./ai-settings')
const { resolveAnsweredQuota } = await import('./billing')
const { getCurrentMonthTokens, getQuotaAnswered } = await import('./ai-usage')
const { maybeWarnQuotaThreshold, maybeNotifyQuotaExhausted } = await import('./ai-handoff-notify')

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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAiSettings).mockResolvedValue(normalizeAiSettings({
    enabled: true,
    systemPrompt: '你是客服',
    shopUrl: '',
    quota: { monthlyTokenCap: 1_000_000, onExceed: 'handoff_all' },
  }))
})

describe('額度預警推給店家的用量句', () => {
  it('🔴 只有 token 上限的帳號：80% 預警⛔不報 token 數字，講「接近 AI 設定裡的上限」', async () => {
    vi.mocked(resolveAnsweredQuota).mockResolvedValue({ internal: false, quota: null, planId: null, periodStart: null })
    vi.mocked(getCurrentMonthTokens).mockResolvedValue(850_000)

    await ask().catch(() => {})
    await flush()

    const text = String((vi.mocked(maybeWarnQuotaThreshold).mock.calls[0]?.[0] as any)?.usageText)
    expect(text).toBe('本月 AI 用量已接近「AI 設定」裡的每月用量上限')
    expect(text).not.toMatch(/token|\d/i)
  })

  it('🔴 用完那則也不報數字，而且講「已達」（那則後面不接百分比，句子自己要讀得通）', async () => {
    vi.mocked(resolveAnsweredQuota).mockResolvedValue({ internal: false, quota: null, planId: null, periodStart: null })
    vi.mocked(getCurrentMonthTokens).mockResolvedValue(1_200_000)

    await ask().catch(() => {})
    await flush()

    const text = String((vi.mocked(maybeNotifyQuotaExhausted).mock.calls[0]?.[0] as any)?.usageText)
    expect(text).toBe('本月 AI 用量已達「AI 設定」裡的每月用量上限')
    expect(text).not.toMatch(/token|\d/i)
  })

  it('有則數額度的帳號照舊報則數（那是他買的單位，看得懂也算得出來）', async () => {
    vi.mocked(resolveAnsweredQuota).mockResolvedValue({ internal: false, quota: 1000, planId: 'basic' as any, periodStart: '2026-09-01' })
    vi.mocked(getQuotaAnswered).mockResolvedValue(850)

    await ask().catch(() => {})
    await flush()

    expect((vi.mocked(maybeWarnQuotaThreshold).mock.calls[0]?.[0] as any)?.usageText).toBe('本期 AI 回覆則數 850/1000')
  })
})
