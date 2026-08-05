/**
 * 2026-08-05 實測災情的整條流程重演（mock 掉 Gemini / Firestore，不打真實 API）。
 *
 * 災情：整場對話在談 MATELASER W1 REGEN 紅光儀（腳本剛回過商品頁連結、AI 前一則也答了它的保固），
 * 客人接著問「有購買優惠嗎」「怎麼購買最方便」→ 檢索全撈到 SHARP 零水鍋的優惠卡（0.77 高分），
 * AI 就把零水鍋的折扣碼端給紅光儀的客人，還回「知識卡中沒有提到…，不過…」並被記成 answered。
 *
 * 這支測的是 answerWithAi 整條流程真的會攔下來（不是只測單一 helper）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SimilarChunk } from './ai-knowledge-chunks'
import type { IntentResult } from './ai-answer'

vi.mock('./firebase', () => ({ getDb: () => ({}) }))

vi.mock('./ai-usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai-usage')>()),
  recordAiUsage: vi.fn(async () => {}),
  getCurrentMonthTokens: vi.fn(async () => 0),
  getQuotaAnswered: vi.fn(async () => 0),
}))

vi.mock('./billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing')>()),
  // internal=true → 完全跳過額度護欄（本測試只關心檢索／作答決策）
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
const { searchSimilarChunks, getWorkspaceProductNames } = await import('./ai-knowledge-chunks')
const { generateJson } = await import('./gemini')
const { recordAiUsage } = await import('./ai-usage')
const { logHandoffEvent } = await import('./ai-handoff-events')

const REGEN = 'MATELASER 筋牌特務 W1 REGEN 多波長紅光舒緩儀'
const ZERO_WATER = 'SHARP HEALSIO 自動調理零水鍋'

function card(partial: Partial<SimilarChunk> & { id: string }): SimilarChunk {
  return {
    title: partial.id,
    content: '內容',
    tags: [],
    similarity: 0.75,
    sourceId: partial.id,
    isOverview: false,
    ...partial,
  }
}

/** 零水鍋的優惠卡（災情裡命中的 top-5 全是這一類） */
const ZERO_WATER_CARDS = [
  card({ id: 'z1', title: 'SHARP自動調理零水鍋與森呼吸NEXT優惠', content: '結帳時輸入折扣碼「NEXT300」可再折 300 元。', similarity: 0.77, productName: ZERO_WATER }),
  card({ id: 'z2', title: 'SHARP HEALSIO 自動調理零水鍋產品特色', content: '無水料理。', similarity: 0.75, productName: ZERO_WATER }),
  card({ id: 'z3', title: 'SHARP HEALSIO 自動調理零水鍋保固', content: '保固一年。', similarity: 0.74, productName: ZERO_WATER }),
]

/** 客人真正在談的那台：脈絡由「腳本回的商品頁連結」+「AI 前一則答保固」建立 */
const HISTORY = [
  { role: 'bot' as const, text: '林瓊惠您好，以下提供商品頁面連結供您參考：https://www.myfeel-tw.com/projects/W1REGEN 若有其他問題，也歡迎隨時與我們聯繫，謝謝您。' },
  { role: 'user' as const, text: '請問有試用期嗎？' },
  { role: 'bot' as const, text: 'W1 REGEN 和 W1 REGEN ULTRA 的保固期限都是自購買日起 1 年。' },
  { role: 'user' as const, text: '好的' },
  { role: 'bot' as const, text: '不客氣！還有需要都可以再跟我說 😊' },
]

const INTENT: IntentResult = {
  intent: 'question',
  isFollowup: false,
  standaloneQuery: '怎麼購買最方便？',
  compareItems: [],
  subQuestions: [],
  inputTokens: 0,
  outputTokens: 0,
}

function ask(query: string, history = HISTORY) {
  return answerWithAi({
    workspaceId: 'ws1',
    query,
    history,
    precomputedIntent: { ...INTENT, standaloneQuery: query },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAiSettings).mockResolvedValue(normalizeAiSettings({
    enabled: true,
    systemPrompt: '你是客服',
    shopUrl: '',
  }))
  vi.mocked(getWorkspaceProductNames).mockResolvedValue([REGEN, ZERO_WATER])
  vi.mocked(generateJson).mockResolvedValue({
    data: { answer: '（不該被呼叫）', hasInfo: true },
    inputTokens: 1,
    outputTokens: 1,
  } as any)
})

describe('answerWithAi 對話級產品鎖', () => {
  it('脈絡在談 W1 REGEN、卡片全是零水鍋 → 轉真人 product_mismatch，且完全不花 LLM', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue(ZERO_WATER_CARDS)

    const res = await ask('怎麼購買最方便？')

    expect(res.decision).toBe('handoff')
    expect(res.handoffReason).toBe('product_mismatch')
    expect(res.answer).toBe('')
    // 沒有進生成階段 = 沒把別台的折扣碼講出去，也沒付 LLM 的錢
    expect(vi.mocked(generateJson)).not.toHaveBeenCalled()
    // sources 仍帶原本撈到的卡：後台脈絡卡要看得出「差點用哪些卡答」才知道要補什麼
    expect(res.sources.map(s => s.chunkId)).toEqual(['z1', 'z2', 'z3'])
    expect(vi.mocked(logHandoffEvent).mock.calls[0]?.[1]).toMatchObject({ reason: 'product_mismatch' })
    // 記 handoff、**不**記 answered（災情裡這三則都被記成 answered、照樣扣則數）
    const deltas = vi.mocked(recordAiUsage).mock.calls.map(c => c[1])
    expect(deltas.some(d => d.handoffs === 1)).toBe(true)
    expect(deltas.some(d => d.answered)).toBe(false)
  })

  it('客人這句自己講了別台 → 以客人這句為準（不被歷史鎖死）', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue(ZERO_WATER_CARDS)

    const res = await ask('零水鍋怎麼買最方便？')

    expect(res.decision).toBe('answered')
    expect(vi.mocked(generateJson)).toHaveBeenCalled()
  })

  it('同一台的卡照答；混進來的別台卡不進 prompt（防混答）', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue([
      card({ id: 'r1', title: 'W1 REGEN 購買方式', content: '請至商品頁下單。', similarity: 0.79, productName: REGEN }),
      ZERO_WATER_CARDS[0]!,
    ])

    const res = await ask('怎麼購買最方便？')

    expect(res.decision).toBe('answered')
    const prompt = String(vi.mocked(generateJson).mock.calls[0]?.[0] ?? '')
    expect(prompt).toContain('W1 REGEN 購買方式')
    expect(prompt).not.toContain('NEXT300')
  })

  it('沒有產品名的通用卡（運費 / 退貨政策）不受產品鎖影響', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue([
      card({ id: 'p1', title: '運費與配送說明', content: '滿千免運。', similarity: 0.8 }),
    ])

    const res = await ask('運費怎麼算？')

    expect(res.decision).toBe('answered')
    expect(vi.mocked(generateJson)).toHaveBeenCalled()
  })

  it('整場沒提過任何產品 → 不鎖，維持原行為', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue(ZERO_WATER_CARDS)

    const res = await ask('怎麼購買最方便？', [
      { role: 'user' as const, text: '你好' },
      { role: 'bot' as const, text: '您好，請問有什麼可以為您服務的嗎？😊' },
    ])

    expect(res.decision).toBe('answered')
  })
})

describe('answerWithAi 「說自己沒資料卻回 hasInfo=true」', () => {
  beforeEach(() => {
    // 卡片與脈絡同一台，讓流程確實走到生成階段
    vi.mocked(searchSimilarChunks).mockResolvedValue([
      card({ id: 'r1', title: 'W1 REGEN 保固', content: '保固一年。', similarity: 0.77, productName: REGEN }),
    ])
  })

  it('「知識卡中沒有提到○○，不過…」→ 改判轉真人，不記 answered', async () => {
    vi.mocked(generateJson).mockResolvedValue({
      data: {
        answer: '您好，知識卡中沒有提到關於試用期的資訊喔。若您是想了解保固相關問題，W1 REGEN 的保固期限是自購買日起 1 年。',
        hasInfo: true,
      },
      inputTokens: 1,
      outputTokens: 1,
    } as any)

    const res = await ask('請問有試用期嗎？')

    expect(res.decision).toBe('handoff')
    expect(res.answer).toBe('')
    const deltas = vi.mocked(recordAiUsage).mock.calls.map(c => c[1])
    expect(deltas.some(d => d.handoffs === 1)).toBe(true)
    expect(deltas.some(d => d.answered)).toBe(false)
  })

  it('正常答案照發（不誤殺）', async () => {
    vi.mocked(generateJson).mockResolvedValue({
      data: { answer: 'W1 REGEN 的保固期限是自購買日起 1 年喔。', hasInfo: true },
      inputTokens: 1,
      outputTokens: 1,
    } as any)

    const res = await ask('保固多久？')

    expect(res.decision).toBe('answered')
    expect(res.answer).toContain('1 年')
  })
})
