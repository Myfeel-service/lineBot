/**
 * 每一種 AI 回覆扣不扣則（`D-132`②，2026-10-19 老闆拍板照建議）：
 *   - 跟本店無關、AI 婉拒（「超出範圍」那句）→ **不扣**：它其實就是答不出來，只是不轉真人
 *   - 寒暄（謝謝→不客氣）、問的商品不在清單 → **照扣**
 * 整張表在 ai-usage.ts 的 UsageDelta.billable。這裡斷言的是 answerWithAi 交給記帳的那一筆
 * （withBilling 之後、真的會寫進額度桶的那份）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimilarChunk } from './ai-knowledge-chunks'
import type { IntentResult, MessageIntent } from './ai-answer'

vi.mock('./firebase', () => ({ getDb: () => ({}) }))

vi.mock('./ai-usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai-usage')>()),
  recordAiUsage: vi.fn(async () => {}),
  getCurrentMonthTokens: vi.fn(async () => 0),
  getQuotaAnswered: vi.fn(async () => 0),
}))
vi.mock('./billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing')>()),
  resolveAnsweredQuota: vi.fn(async () => ({ internal: true, quota: null, periodStart: null })),
}))
vi.mock('./ai-handoff-events', () => ({ logHandoffEvent: vi.fn() }))
vi.mock('./ai-handoff-notify', () => ({ maybeWarnQuotaThreshold: vi.fn(async () => {}) }))
vi.mock('./gemini', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gemini')>()),
  embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
  estimateTokens: vi.fn(() => 10),
  generateJson: vi.fn(),
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
const { generateJson } = await import('./gemini')
const { searchSimilarChunks, getWorkspaceProductNames } = await import('./ai-knowledge-chunks')
const { recordAiUsage } = await import('./ai-usage')

function card(partial: Partial<SimilarChunk> & { id: string }): SimilarChunk {
  return { title: partial.id, content: '內容', tags: [], similarity: 0.85, sourceId: partial.id, isOverview: false, ...partial }
}

function intent(kind: MessageIntent, query: string): IntentResult {
  return { intent: kind, isFollowup: false, standaloneQuery: query, compareItems: [], subQuestions: [], inputTokens: 0, outputTokens: 0 }
}

async function ask(query: string, kind: MessageIntent, extra: Record<string, unknown> = {}) {
  const res = await answerWithAi({ workspaceId: 'ws1', query, precomputedIntent: intent(kind, query), ...extra })
  const calls = vi.mocked(recordAiUsage).mock.calls.map(c => c[1])
  return { res, delta: calls.at(-1)! }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAiSettings).mockResolvedValue(normalizeAiSettings({ enabled: true, systemPrompt: '你是客服', shopUrl: '' }))
  vi.mocked(searchSimilarChunks).mockResolvedValue([])
  vi.mocked(getWorkspaceProductNames).mockResolvedValue([])
})

describe('超出範圍（跟本店無關、AI 婉拒）→ 不扣則', () => {
  it('意圖分類判成閒聊／代工（「幫我寫一首詩」）→ 品質照算答完，但不扣則', async () => {
    const { res, delta } = await ask('幫我寫一首詩', 'offtopic')
    expect(res.answerKind).toBe('offtopic')
    expect(res.decision).toBe('answered')
    expect(delta.answered).toBe(1) // 「AI 自己收尾、沒轉真人」——AI 表現頁的恆等式要湊得滿
    expect(delta.unbilledAnswered).toBe(1)
    expect(delta.billable).toBeUndefined()
  })

  it('分類漏掉、寫答案那一步才發現無關（offTopic=true）→ 一樣不扣', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue([card({ id: 'c1', title: '保固說明' })])
    vi.mocked(generateJson).mockResolvedValue({ data: { answer: '', hasInfo: false, offTopic: true }, inputTokens: 5, outputTokens: 5 } as any)
    const { res, delta } = await ask('今天天氣如何', 'question')
    expect(res.answerKind).toBe('offtopic')
    expect(delta.unbilledAnswered).toBe(1)
    expect(delta.billable).toBeUndefined()
  })

  it('反問後客人點的選項被判成無關 → 不扣，也不算「反問有效」', async () => {
    const { res } = await ask('幫我寫一首詩', 'offtopic', { isFollowup: true, followupOf: '保固多久' })
    expect(res.answerKind).toBe('offtopic')
    // followup 只記 token（這題沒有 token）＋答出的那兩顆；婉拒兩顆都不該出現
    const all = vi.mocked(recordAiUsage).mock.calls.map(c => c[1])
    expect(all.some(d => d.billable || d.followupAnswered)).toBe(false)
  })
})

describe('寒暄、商品不在清單 → 照扣', () => {
  it('客人說謝謝 → 回「不客氣」照扣一則', async () => {
    const { res, delta } = await ask('謝謝', 'thanks')
    expect(res.answerKind).toBe('social')
    expect(delta.billable).toBe(1)
  })

  it('打招呼 → 照扣一則', async () => {
    const { delta } = await ask('你好', 'greeting')
    expect(delta.billable).toBe(1)
  })

  it('問「有賣 X 嗎」而清單裡沒有 → 回現有品項，照扣一則', async () => {
    vi.mocked(getWorkspaceProductNames).mockResolvedValue(['電淨艙', '小滑手', '乾淨方MAX'])
    const { res, delta } = await ask('你們有賣加濕器嗎', 'list')
    expect(res.answer).toContain('目前的商品資料裡沒有找到')
    expect(delta.billable).toBe(1)
  })
})

describe('其他口徑不變（對照組，證明這張網撈得到「有扣」）', () => {
  it('一般答出 → 扣一則', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue([card({ id: 'w', title: '保固說明', content: '保固一年。' })])
    vi.mocked(generateJson).mockResolvedValue({ data: { answer: '保固是一年喔。', hasInfo: true }, inputTokens: 5, outputTokens: 5 } as any)
    const { res, delta } = await ask('保固多久', 'question')
    expect(res.decision).toBe('answered')
    expect(delta.billable).toBe(1)
  })

  it('查他那一筆訂單：先給一般規則再轉真人 → 不扣（D-132①）', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue([card({ id: 's', title: '出貨時程', content: '3～5 個工作日出貨。' })])
    vi.mocked(generateJson).mockResolvedValue({ data: { answer: '一般 3～5 個工作日出貨。', hasInfo: true }, inputTokens: 5, outputTokens: 5 } as any)
    const { res, delta } = await ask('我的訂單到哪了', 'order_status')
    expect(res.decision).toBe('handoff')
    expect(delta.handoffs).toBe(1)
    expect(delta.billable).toBeUndefined()
  })

  it('playground 測試的無關問題 → 不扣（測試本來就不扣）', async () => {
    const { delta } = await ask('幫我寫一首詩', 'offtopic', { isTest: true })
    expect(delta.billable).toBeUndefined()
  })
})
