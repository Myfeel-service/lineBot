/**
 * 個案訂單狀態的分流（2026-08-05 實測災情後補）。
 *
 * 災情：客人問「商品早已收回系統仍顯示退貨處理中」「這筆狀態」——知識庫只有退款政策、
 * 沒有任何人的訂單，檢索註定撈不齊 → 走 low_confidence 的「需要幫您轉接專員嗎？」
 * 二次確認，客人得再打一次「轉接專員」才轉得動，同一場對話為此鬼打牆兩輪。
 *
 * 現在的口徑（兩件事都要做到）：
 *   · 一般規則（幾天出貨、幾號退款）知識庫查得到就先答給客人
 *   · 「他那一筆」只有人查得到 → 一定轉真人，且不進二次確認
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
const { searchSimilarChunks } = await import('./ai-knowledge-chunks')
const { recordAiUsage } = await import('./ai-usage')
const { logHandoffEvent } = await import('./ai-handoff-events')

function card(partial: Partial<SimilarChunk> & { id: string }): SimilarChunk {
  return {
    title: partial.id, content: '內容', tags: [], similarity: 0.8,
    sourceId: partial.id, isOverview: false, ...partial,
  }
}

function intent(kind: MessageIntent, query: string): IntentResult {
  return {
    intent: kind,
    isFollowup: false,
    standaloneQuery: query,
    compareItems: [],
    subQuestions: [],
    inputTokens: 0,
    outputTokens: 0,
  }
}

function ask(query: string, kind: MessageIntent) {
  return answerWithAi({
    workspaceId: 'ws1',
    query,
    precomputedIntent: intent(kind, query),
  })
}

/** recordAiUsage 收到的所有 delta（每次答題只會記一種結果） */
function deltas() {
  return vi.mocked(recordAiUsage).mock.calls.map(c => c[1])
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAiSettings).mockResolvedValue(normalizeAiSettings({
    enabled: true,
    systemPrompt: '你是客服',
    shopUrl: '',
  }))
  vi.mocked(generateJson).mockResolvedValue({
    data: { answer: '（不該被呼叫）', hasInfo: true },
    inputTokens: 1,
    outputTokens: 1,
  } as any)
})

describe('個案訂單狀態：先給規則、再真的轉真人', () => {
  it('知識庫有一般規則 → 規則當 answer 帶回去，但結論仍是轉真人', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue([
      card({ id: 'ship1', title: '出貨與退款時程', content: '訂單成立後 3～5 個工作日出貨；退款於受理後次月 15 日匯款。', similarity: 0.82 }),
    ])
    vi.mocked(generateJson).mockResolvedValue({
      data: { answer: '一般是訂單成立後 3～5 個工作日出貨喔。', hasInfo: true },
      inputTokens: 20, outputTokens: 30,
    } as any)

    const res = await ask('我的訂單到哪了', 'order_status')

    // 有去查知識庫、也真的生成了規則
    expect(vi.mocked(generateJson)).toHaveBeenCalled()
    expect(res.answer).toContain('3～5 個工作日')
    // 但客人要的是「他那一筆」→ 結論一定是轉真人
    expect(res.decision).toBe('handoff')
    expect(res.handoffReason).toBe('order_status')
  })

  it('這一則記 handoff、不記 answered（結局是交給真人，不算 AI 自己答完）', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue([
      card({ id: 'ship1', title: '出貨時程', content: '3～5 個工作日出貨。', similarity: 0.82 }),
    ])
    vi.mocked(generateJson).mockResolvedValue({
      data: { answer: '一般 3～5 個工作日出貨。', hasInfo: true }, inputTokens: 20, outputTokens: 30,
    } as any)

    await ask('這筆狀態', 'order_status')

    expect(deltas().some(d => d.handoffs === 1)).toBe(true)
    expect(deltas().some(d => d.answered)).toBe(false)
    expect(vi.mocked(logHandoffEvent).mock.calls[0]?.[1]).toMatchObject({ reason: 'order_status' })
  })

  it('知識庫連規則都沒有 → 仍是 order_status，不是 no_grounding（不能落進「要不要幫您轉接」）', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue([])

    const res = await ask('商品早已收回系統仍顯示退貨處理中', 'order_status')

    expect(res.decision).toBe('handoff')
    expect(res.handoffReason).toBe('order_status')
    expect(res.answer).toBe('')
  })

  it('order_status 不列入知識缺口（補卡救不了「要查訂單」）', async () => {
    const { KNOWLEDGE_GAP_HANDOFF_REASONS } = await import('~~/shared/types/ai-knowledge')
    expect(KNOWLEDGE_GAP_HANDOFF_REASONS.has('order_status')).toBe(false)
  })

  it('轉真人二次確認的名單不含 order_status（要直接轉，不要再問一次）', async () => {
    // handler 端用這份名單決定「先問要不要轉接」；order_status 不在裡面才會直接轉。
    const src = await import('node:fs').then(fs => fs.readFileSync('server/utils/handler.ts', 'utf8'))
    const line = src.split('\n').find(l => l.includes('HANDOFF_CONFIRM_REASONS = new Set'))
    expect(line).toBeTruthy()
    expect(line).not.toContain('order_status')
  })
})

describe('招呼語照舊計入則數（老闆拍板：不分開算）', () => {
  it('道謝 → 回罐頭，仍記 answered（會扣一則額度）', async () => {
    const res = await ask('謝謝您', 'thanks')

    expect(res.decision).toBe('answered')
    expect(res.answerKind).toBe('social')
    expect(res.answer).toContain('不客氣')
    expect(deltas().some(d => d.answered === 1)).toBe(true)
  })

  it('越界拒答（閒聊／代寫）同樣記 answered', async () => {
    const res = await ask('幫我寫一首詩', 'offtopic')

    expect(res.decision).toBe('answered')
    expect(res.answerKind).toBe('offtopic')
    expect(deltas().some(d => d.answered === 1)).toBe(true)
  })
})
