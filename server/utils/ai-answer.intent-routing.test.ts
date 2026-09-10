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
import type { AiChatTurn, IntentResult, MessageIntent } from './ai-answer'

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

const { answerWithAi, routeMessage, classifyIntent, mentionsOwnOrder, socialCannedReply } = await import('./ai-answer')
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

/**
 * order_status 後檢（2026-09-10 正式站災情後補）。
 *
 * 災情：客人問「請問下訂後多久會收到？」——還沒下單、問的是一般出貨時程，卻被分類器
 * 判成 order_status。AI 已經完整答出「9 月底依訂單順序陸續出貨」，後面照樣接一句轉接訊息；
 * 當下又在勿擾時段，那句轉接訊息被換成「目前非客服服務時間」＝客人看到 AI 答完又說沒人在，
 * 而勿擾時段不推播客服，那場就躺在待真人佇列到隔天。記帳上還記 handoff 不記 answered。
 *
 * 判成 order_status 的代價（必轉真人＋跳過二次確認）比其他意圖都高，所以模型判完再確認一次
 * 句子裡真的有「他自己那一筆」。方向單向：只收窄、不擴張。
 */
describe('order_status 後檢：沒有「他那一筆」的線索就不轉真人', () => {
  /** 讓路由器回一個指定的 intent（模擬模型判斷），下一次 generateJson 才是答題生成 */
  function mockRouter(kind: MessageIntent, standaloneQuery: string) {
    vi.mocked(generateJson).mockResolvedValueOnce({
      data: { scriptId: null, intent: kind, isFollowup: false, standaloneQuery, compareItems: [], subQuestions: [] },
      inputTokens: 5, outputTokens: 5,
    } as any)
  }

  it('「請問下訂後多久會收到？」被判 order_status → 退回 question', async () => {
    mockRouter('order_status', '請問下訂後多久會收到？')

    const route = await routeMessage('請問下訂後多久會收到？', [])

    expect(route?.intent).toBe('question')
    expect(route?.orderStatusDemoted).toBe(true)
  })

  it('整條路走完：AI 答完就結案，不再接一句轉接訊息', async () => {
    // handler 的實際做法：routeMessage 的結果當 precomputedIntent 餵給 answerWithAi
    mockRouter('order_status', '請問下訂後多久會收到？')
    const route = await routeMessage('請問下訂後多久會收到？', [])

    vi.mocked(searchSimilarChunks).mockResolvedValue([
      card({ id: 'ship1', title: '出貨時程', content: '預計 9 月底依訂單順序陸續出貨。', similarity: 0.82 }),
    ])
    vi.mocked(generateJson).mockResolvedValue({
      data: { answer: '預計 9 月底依照訂單順序陸續出貨喔！', hasInfo: true },
      inputTokens: 20, outputTokens: 30,
    } as any)

    const res = await answerWithAi({ workspaceId: 'ws1', query: '請問下訂後多久會收到？', precomputedIntent: route! })

    // 修好之前這裡是 handoff / order_status：客人拿到答案之後又被轉真人
    expect(res.decision).toBe('answered')
    expect(res.handoffReason).toBeNull()
    expect(deltas().some(d => d.answered === 1)).toBe(true)
    expect(deltas().some(d => d.handoffs)).toBe(false)
  })

  it('真的在問自己那一筆 → 照舊轉真人（後檢只收窄，不誤殺）', async () => {
    for (const q of [
      '我的訂單到哪了',
      '這筆到哪了',
      '單號 M123456 寄了嗎',
      '東西已經寄回去了為什麼還沒退款',
      '商品早已收回系統仍顯示退貨處理中',
      '我上禮拜買的怎麼還沒到',
    ]) {
      mockRouter('order_status', q)
      const route = await routeMessage(q, [])
      expect(route?.intent, q).toBe('order_status')
      expect(route?.orderStatusDemoted, q).toBeFalsy()
    }
  })

  it('只問規則的問法即使被判 order_status，也一律退回 question', async () => {
    for (const q of ['退款要幾天', '怎麼申請退貨', '運費多少', '下單後幾天出貨', '預購什麼時候寄', '什麼時候到貨']) {
      mockRouter('order_status', q)
      const route = await routeMessage(q, [])
      expect(route?.intent, q).toBe('question')
      expect(route?.orderStatusDemoted, q).toBe(true)
    }
  })

  it('線索只在改寫句裡（客人先報過單號、這句只說「那多久會到」）→ 保留 order_status', async () => {
    mockRouter('order_status', '我的訂單 M123456 多久會到')

    const route = await routeMessage('那多久會到', [])

    expect(route?.intent).toBe('order_status')
    expect(route?.orderStatusDemoted).toBeFalsy()
  })

  it('classifyIntent（路由器失敗時的後備）走同一道後檢', async () => {
    vi.mocked(generateJson).mockResolvedValueOnce({
      data: { intent: 'order_status', isFollowup: false, standaloneQuery: '請問下訂後多久會收到？', compareItems: [], subQuestions: [] },
      inputTokens: 5, outputTokens: 5,
    } as any)

    const res = await classifyIntent('請問下訂後多久會收到？')

    expect(res?.intent).toBe('question')
    expect(res?.orderStatusDemoted).toBe(true)
  })

  it('後檢只對 order_status 生效，其他意圖原封不動', async () => {
    mockRouter('question', '這台除濕機多少錢')
    const route = await routeMessage('這台除濕機多少錢', [])

    expect(route?.intent).toBe('question')
    expect(route?.orderStatusDemoted).toBe(false)
    // 線索表本身：規則問法不該命中、個案問法要命中
    expect(mentionsOwnOrder('請問下訂後多久會收到？')).toBe(false)
    expect(mentionsOwnOrder('我的訂單到哪了')).toBe(true)
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

/**
 * 婉拒（no_need）＋ 後檢（2026-09-11 正式站災情後補）。
 *
 * 災情：12:12 AI 開場問「請問有什麼可以為您服務的嗎？」，12:13 客人回「目前沒有(喔)」，
 * AI 把它當成「客人問了一個我答不出來的問題」，回「這個問題我不太確定該怎麼回答，
 * 需要幫您轉接專員嗎？」＋兩顆按鈕。客人說沒事、系統要轉他去真人；只要按下那顆按鈕，
 * 真人就被叫來處理一個不存在的問題。記帳上這輪還記 handoff 不記 answered。
 *
 * ⛔ 後檢的方向跟 order_status 一樣是單向收窄：誤判的代價是把客人**真正的回答**
 *    （bot 問「您收到了嗎」→「沒有」）當成「他沒事了」收掉，比漏判嚴重得多。
 */
describe('婉拒：客人說「沒事了」不算答不出來', () => {
  function mockRouter(kind: MessageIntent, standaloneQuery: string) {
    vi.mocked(generateJson).mockResolvedValueOnce({
      data: { scriptId: null, intent: kind, isFollowup: false, standaloneQuery, compareItems: [], subQuestions: [] },
      inputTokens: 5, outputTokens: 5,
    } as any)
  }
  /** 災情當下的上一則：AI 的開場招呼（⛔ 句尾是表情符號，不是問號） */
  const afterGreeting: AiChatTurn[] = [{ role: 'bot', text: '您好，請問有什麼可以為您服務的嗎？😊' }]

  it('開場招呼後回「目前沒有(喔)」→ 保留 no_need', async () => {
    mockRouter('no_need', '目前沒有')

    const route = await routeMessage('目前沒有(喔)', [], afterGreeting)

    expect(route?.intent).toBe('no_need')
    expect(route?.noNeedDemoted).toBeFalsy()
  })

  it('整條路走完：回一句「有需要隨時再跟我說」，不問要不要轉接、不記 handoff', async () => {
    mockRouter('no_need', '目前沒有')
    const route = await routeMessage('目前沒有(喔)', [], afterGreeting)

    const res = await answerWithAi({
      workspaceId: 'ws1',
      query: '目前沒有(喔)',
      history: afterGreeting,
      precomputedIntent: route!,
    })

    // 修好之前這裡是 handoff / low_confidence：客人說沒事，系統問他要不要轉接專員
    expect(res.decision).toBe('answered')
    expect(res.handoffReason).toBeNull()
    expect(res.answerKind).toBe('social')
    expect(res.answer).toContain('有需要隨時再跟我說')
    expect(deltas().some(d => d.answered === 1)).toBe(true)
    expect(deltas().some(d => d.handoffs)).toBe(false)
    // 沒去查知識庫（罐頭直接短路）
    expect(vi.mocked(searchSimilarChunks)).not.toHaveBeenCalled()
  })

  it('「還有其他問題嗎」這種收尾問句後面的「沒有」也算婉拒', async () => {
    for (const bot of ['還有其他問題嗎？', '請問還有什麼需要幫您服務的嗎？😊', '有什麼可以幫您的嗎']) {
      mockRouter('no_need', '沒有了')
      const route = await routeMessage('沒有了', [], [{ role: 'bot', text: bot }])
      expect(route?.intent, bot).toBe('no_need')
    }
  })

  it('⛔ 上一則機器人在問具體問題 → 這句是回答，退回 question', async () => {
    for (const bot of [
      '請問是哪一台除濕機呢？',
      '請問您收到商品了嗎？',
      '方便提供訂單編號嗎？',
      '請問要選 A 還是 B？',
      // ⛔ 沒有問號、靠「呢」收尾、後面還掛表情符號——反問澄清最常見的長相
      '請問是哪一台除濕機呢 😊',
    ]) {
      mockRouter('no_need', '沒有')
      const route = await routeMessage('沒有', [], [{ role: 'bot', text: bot }])
      expect(route?.intent, bot).toBe('question')
      expect(route?.noNeedDemoted, bot).toBe(true)
    }
  })

  it('⛔ 上一則不是機器人說的話（沒有東西可以婉拒）→ 退回 question', async () => {
    for (const history of [
      [] as AiChatTurn[],
      [{ role: 'user' as const, text: '我想問除濕機' }],
    ]) {
      mockRouter('no_need', '沒有')
      const route = await routeMessage('沒有', [], history)
      expect(route?.intent).toBe('question')
      expect(route?.noNeedDemoted).toBe(true)
    }
  })

  it('判成 no_need 就不進腳本（說沒事了還被推進流程＝拉著要走的人繼續問）', async () => {
    vi.mocked(generateJson).mockResolvedValueOnce({
      data: { scriptId: 's1', intent: 'no_need', isFollowup: false, standaloneQuery: '沒有', compareItems: [], subQuestions: [] },
      inputTokens: 5, outputTokens: 5,
    } as any)

    const route = await routeMessage('沒有', [{ id: 's1', name: '查詢訂單', hints: ['查訂單'] }], afterGreeting)

    expect(route?.intent).toBe('no_need')
    expect(route?.scriptId).toBeNull()
  })

  it('classifyIntent（路由器失敗時的後備）走同一道後檢', async () => {
    vi.mocked(generateJson).mockResolvedValueOnce({
      data: { intent: 'no_need', isFollowup: false, standaloneQuery: '沒有', compareItems: [], subQuestions: [] },
      inputTokens: 5, outputTokens: 5,
    } as any)
    const kept = await classifyIntent('目前沒有(喔)', afterGreeting)
    expect(kept?.intent).toBe('no_need')

    vi.mocked(generateJson).mockResolvedValueOnce({
      data: { intent: 'no_need', isFollowup: false, standaloneQuery: '沒有', compareItems: [], subQuestions: [] },
      inputTokens: 5, outputTokens: 5,
    } as any)
    const demoted = await classifyIntent('沒有', [{ role: 'bot', text: '請問您收到商品了嗎？' }])
    expect(demoted?.intent).toBe('question')
    expect(demoted?.noNeedDemoted).toBe(true)
  })

  it('連 LLM 都掛掉時的 regex 後備：一樣要看上一則講了什麼', () => {
    // 命中：開場招呼後的婉拒（括號要先剝掉，否則「目前沒有(喔)」整句比不中）
    for (const q of ['目前沒有(喔)', '沒有', '沒事了', '不用了', '不需要', '先這樣', '我再看看']) {
      expect(socialCannedReply(q, afterGreeting), q).toContain('有需要隨時再跟我說')
    }
    // 不命中：上一則在問具體問題（這句是回答）／沒有上一則機器人訊息
    expect(socialCannedReply('沒有', [{ role: 'bot', text: '請問您收到商品了嗎？' }])).toBeNull()
    expect(socialCannedReply('沒有')).toBeNull()
    // 不命中：帶了實際問題
    expect(socialCannedReply('沒有耶，那運費多少', afterGreeting)).toBeNull()
  })

  it('後檢只對 no_need 生效，其他意圖原封不動', async () => {
    mockRouter('question', '這台除濕機多少錢')
    const route = await routeMessage('這台除濕機多少錢', [], afterGreeting)

    expect(route?.intent).toBe('question')
    expect(route?.noNeedDemoted).toBe(false)
  })
})
