/**
 * `C-307`（考卷找到的錯）＋ 2026-10-19 正式站兩件，整條 answerWithAi 流程重演（mock 掉 Gemini／Firestore）。
 *
 *   ① 同一份資料進 prompt 只留一條 → 每份最多 3 條（考卷 Q63「HD7000 黏鍋」只剩「限用物質」那條）
 *   ② 型號命中的卡照存放順序取前 3 條 → 照相似度挑（這裡驗答題端有把這句的向量交出去；挑法本身在 ai-knowledge-chunks.tag-rank.test.ts）
 *   ③「客人在講他自己那一筆」漏詞：已申請／已收回／是否已退款、「9/6下單的」（考卷 Q06）
 *   ④ 10/19 11:01：客人講「SHARP 乾淨方MAX」問出貨，AI 反問「哪一個商品」——品牌「SHARP」四台＋「除濕機」三台被聯集成 6 台
 *   ⑤ 10/19 12:44：客人打「g. 2l4」「好的」，AI 兩次回「SHARP 乾淨方MAX 的產地是中國」
 *
 * 商品名、別名照抄 MYFEEL 正式資料（2026-10-19 唯讀查）：認商品這件事吃的就是這份字典，假字典驗不出共用字的問題。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  getProductAliases: vi.fn(async () => ({ aliases: {}, aliasLabels: {}, dismissedPairs: [] })),
}))

const {
  answerWithAi, activeProductsInContext, productsInConversation, pickMentionedProducts, mentionsOwnOrder, routeMessage,
  SHIP_WHICH_PRODUCT_TEXT,
} = await import('./ai-answer')
// 這兩支 2026-10-19 搬到 shared（handler 叫 AI 之前也要用）
const { isAcknowledgementOnly, looksLikeZhuyinTypo } = await import('~~/shared/quiet-reply')
const { getAiSettings, normalizeAiSettings } = await import('./ai-settings')
const { searchSimilarChunks, searchChunksByIdentifierTag, getWorkspaceProductNames } = await import('./ai-knowledge-chunks')
const { generateJson } = await import('./gemini')
const { getProductAliases, productVocabulary, normalizeProductName } = await import('./ai-product-alias')
const { recordAiUsage } = await import('./ai-usage')
const { isSingleProductContext } = await import('~~/shared/ship-timing-question')

// ── MYFEEL 正式資料（2026-10-19）：在用的商品名＋別名 ───────────────────
const NAMES = [
  'Giaretti 珈樂堤《小滑手》全自動義式咖啡機 GL-5680',
  'SHARP「乾淨方MAX」',
  'MATELASER 筋牌特務 W1 REGEN ULTRA',
  'BOYA mini2',
  'KIESLECT 小耳記',
  'CHIMEI 靜電集塵空氣清淨機 AP-08SPFG (電淨艙)',
  '粒粒安 飛利浦 IH 智慧電子鍋 HD7000',
  'GPLUS 居不可濕',
  'Poketomo 口袋同萌',
  '兩全奇美燈',
  'SHARP iBarista 智慧咖啡機',
  '猩猩仙人之握',
  'SHARP 自動調理零水鍋',
  '上好ㄟ抽取式除濕機',
  'MATELASER 筋牌特務 W1 REGEN',
  'Cheerble 飲水機',
]
const ALIAS_LABELS: Record<string, string> = {
  sharp頂級a咖: 'SHARP 頂級A咖',
  ibarista智慧咖啡機: 'iBarista 智慧咖啡機',
  粒粒安飛利浦ih智慧電子鍋: '粒粒安 飛利浦 IH 智慧電子鍋',
  chimei靜電集塵空氣清淨機ap08spfg: 'CHIMEI 靜電集塵空氣清淨機 AP-08SPFG',
  ibarista: 'iBarista',
  poketomo: 'Poketomo',
  cheerble: 'Cheerble',
  粒粒安: '粒粒安',
  sharp變頻除濕機dwux19ftwdwux22fthdwux22ftw: 'SHARP 變頻除濕機 DW-UX19FT-W DW-UX22FT-H DW-UX22FT-W',
  kieslectainotepods10s: 'Kieslect AI NotePods 10S',
  奇美靜電集塵空氣清淨機ap08spfg: '奇美 靜電集塵空氣清淨機 AP-08SPFG',
  gplus除濕機: 'GPLUS 除濕機',
  sharphealsio24l自動調理零水鍋: 'SHARP HEALSIO 2.4L 自動調理零水鍋',
  nwt威技新一級能效16l高效抽取型除濕機: 'NWT 威技 新一級能效 16L 高效抽取型除濕機',
  nwt威技除濕機: 'NWT 威技 除濕機',
  sharp小獴友poketomo口袋同萌: 'SHARP 小獴友 Poketomo 口袋同萌',
}
const ALIASES: Record<string, string> = {
  sharp頂級a咖: 'iBarista 智慧咖啡機',
  ibarista智慧咖啡機: 'SHARP iBarista 智慧咖啡機',
  粒粒安飛利浦ih智慧電子鍋: '粒粒安 飛利浦 IH 智慧電子鍋 HD7000',
  chimei靜電集塵空氣清淨機ap08spfg: 'CHIMEI 靜電集塵空氣清淨機 AP-08SPFG (電淨艙)',
  ibarista: 'SHARP iBarista 智慧咖啡機',
  poketomo: 'Poketomo 口袋同萌',
  cheerble: 'Cheerble 飲水機',
  粒粒安: '粒粒安 飛利浦 IH 智慧電子鍋 HD7000',
  sharp變頻除濕機dwux19ftwdwux22fthdwux22ftw: 'SHARP「乾淨方MAX」',
  kieslectainotepods10s: 'KIESLECT 小耳記',
  奇美靜電集塵空氣清淨機ap08spfg: 'CHIMEI 靜電集塵空氣清淨機 AP-08SPFG (電淨艙)',
  gplus除濕機: 'GPLUS 居不可濕',
  sharphealsio24l自動調理零水鍋: 'SHARP 自動調理零水鍋',
  nwt威技新一級能效16l高效抽取型除濕機: '上好ㄟ抽取式除濕機',
  nwt威技除濕機: '上好ㄟ抽取式除濕機',
  sharp小獴友poketomo口袋同萌: 'Poketomo 口袋同萌',
}
const VOCAB = productVocabulary(NAMES, { aliases: ALIASES, aliasLabels: ALIAS_LABELS })
const key = (n: string) => normalizeProductName(n)
const MAX = 'SHARP「乾淨方MAX」'

/** 正式站 10/19 11:01 客人原句 */
const SHIP_NAMED_LIVE = '請問，SHARP「乾淨方MAX」 雙氣流智慧變頻美學清淨除濕機 (DW-UX22FT)何時會安排出貨,9/6下單的'
/** 重現句（同一件事的短版） */
const SHIP_NAMED = '請問 SHARP 乾淨方MAX 什麼時候出貨'

function card(partial: Partial<SimilarChunk> & { id: string }): SimilarChunk {
  return { title: partial.id, content: '內容', tags: [], similarity: 0.8, sourceId: partial.id, isOverview: false, ...partial }
}

function intent(kind: MessageIntent, query: string): IntentResult {
  return { intent: kind, isFollowup: false, standaloneQuery: query, compareItems: [], subQuestions: [], inputTokens: 0, outputTokens: 0 }
}

/** 答題那一次 generateJson 收到的 prompt */
const lastPrompt = () => String(vi.mocked(generateJson).mock.calls.at(-1)?.[0] ?? '')
const deltas = () => vi.mocked(recordAiUsage).mock.calls.map(c => c[1])

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAiSettings).mockResolvedValue(normalizeAiSettings({ enabled: true, systemPrompt: '你是客服', shopUrl: '' }))
  vi.mocked(getWorkspaceProductNames).mockResolvedValue(NAMES)
  vi.mocked(getProductAliases).mockResolvedValue({ aliases: ALIASES, aliasLabels: ALIAS_LABELS, dismissedPairs: [] })
  vi.mocked(searchSimilarChunks).mockReset().mockResolvedValue([])
  vi.mocked(searchChunksByIdentifierTag).mockReset().mockResolvedValue([])
  vi.mocked(generateJson).mockReset().mockResolvedValue({ data: { answer: '（答題）', hasInfo: true }, inputTokens: 1, outputTokens: 1 } as any)
})

// ═══════════════════════════════════════════════════════════════════
describe('④ 認商品：只對到一台的字優先，品牌／品類共用字只在沒有更具體線索時才算', () => {
  const products = (text: string, history: AiChatTurn[] = []) =>
    [...(activeProductsInContext(text, history, VOCAB, ALIASES)?.products ?? [])].sort()

  it('🔴 正式站 11:01 原句、重現句 → 只認乾淨方MAX 一台（以前 SHARP 四台＋除濕機三台＝6 台）', () => {
    expect(products(SHIP_NAMED_LIVE)).toEqual([key(MAX)])
    expect(products(SHIP_NAMED)).toEqual([key(MAX)])
    expect(products('DW-UX22FT 什麼時候到貨')).toEqual([key(MAX)])
  })

  it('只講品牌或品類 → 照舊是好幾台（沒有更具體的字）', () => {
    expect(products('除濕機什麼時候出貨')).toHaveLength(3)
    expect(products('SHARP 有什麼')).toHaveLength(4)
    expect(products('咖啡機何時出貨')).toHaveLength(2)
  })

  it('型號家族：講到 ULTRA 就只認 ULTRA；只講 W1 REGEN 兩台都算', () => {
    expect(products('W1 REGEN ULTRA 保固多久')).toEqual([key('MATELASER 筋牌特務 W1 REGEN ULTRA')])
    expect(products('W1 REGEN 保固多久')).toHaveLength(2)
  })

  it('同一句點名兩台 → 兩台都算（不是只挑一台）', () => {
    expect(products('SHARP iBarista 跟小滑手差在哪')).toEqual(
      [key('Giaretti 珈樂堤《小滑手》全自動義式咖啡機 GL-5680'), key('SHARP iBarista 智慧咖啡機')].sort(),
    )
  })

  it('⛔ 具體的字跟品牌打架（「SHARP 全自動咖啡機」：全自動只在小滑手的名字裡）→ 不挑邊，照舊當成好幾台', () => {
    const ps = products('SHARP 全自動咖啡機什麼時候出貨')
    expect(ps.length).toBeGreaterThan(1)
    expect(ps).toContain(key('SHARP iBarista 智慧咖啡機'))
  })

  it('別名（叫法）也算具體的字：「NWT 威技 除濕機」只認上好ㄟ', () => {
    expect(products('NWT 威技 除濕機怎麼排水')).toEqual([key('上好ㄟ抽取式除濕機')])
  })

  it('前面的訊息也用同一把尺（脈絡從對話來時）', () => {
    const r = activeProductsInContext('我的什麼時候出貨', [{ role: 'user', text: SHIP_NAMED_LIVE }], VOCAB, ALIASES)
    expect(r?.from).toBe('history')
    expect([...r!.products]).toEqual([key(MAX)])
  })

  it('pickMentionedProducts：規則本身', () => {
    const s = (...xs: string[]) => new Set(xs)
    // 只有共用字 → 全部
    expect([...pickMentionedProducts([{ products: s('a', 'b'), owners: s('a', 'b') }])].sort()).toEqual(['a', 'b'])
    // 有具體的字、共用字也涵蓋它 → 只留具體的
    expect([...pickMentionedProducts([
      { products: s('a', 'b', 'c'), owners: s('a', 'b', 'c') },
      { products: s('a'), owners: s('a') },
    ])]).toEqual(['a'])
    // 共用字裡沒有具體那台 → 打架，退回全部
    expect([...pickMentionedProducts([
      { products: s('b', 'c'), owners: s('b', 'c') },
      { products: s('a'), owners: s('a') },
    ])].sort()).toEqual(['a', 'b', 'c'])
    expect(pickMentionedProducts([]).size).toBe(0)
  })

  it('🔴 handler「要不要繞過查詢訂單流程」用的 productsInConversation 也拿到一台（handler.ts 那一行呼叫的就是它）', async () => {
    const live = await productsInConversation('ws1', SHIP_NAMED_LIVE, [])
    expect(isSingleProductContext(live)).toBe(true)
    expect([...live!.products]).toEqual([key(MAX)])
    const short = await productsInConversation('ws1', SHIP_NAMED, [])
    expect(isSingleProductContext(short)).toBe(true)
  })

  describe('整條 answerWithAi', () => {
    const MAX_SHIP = card({
      id: 'max_ship', title: 'SHARP「乾淨方MAX」 雙氣流智慧變頻美學清淨除濕機 (DW-UX22FT)', productName: MAX, similarity: 0.786, sourceId: 'p_ship',
      content: '依原廠公告：商品預計於 10 月中旬依照訂單順序陸續出貨。',
    })
    const MAX_ORIGIN = card({ id: 'max_origin', title: 'SHARP 乾淨方MAX 產地', productName: MAX, similarity: 0.772, sourceId: 'p_max', content: '產地：中國。' })
    const IBARISTA_SHIP = card({ id: 'iba_ship', title: 'SHARP iBarista 智慧咖啡機', similarity: 0.76, sourceId: 'p_ship', content: '第二批 11 月底出貨。' })
    const GL_SHIP = card({ id: 'gl_ship', title: '小滑手', similarity: 0.75, sourceId: 'p_ship', content: '10/7 起第二批 11 月底。' })

    beforeEach(() => {
      vi.mocked(searchSimilarChunks).mockResolvedValue([MAX_SHIP, MAX_ORIGIN, IBARISTA_SHIP, GL_SHIP])
      vi.mocked(generateJson).mockResolvedValue({ data: { answer: '乾淨方MAX 預計 10 月中旬依訂單順序陸續出貨喔！', hasInfo: true }, inputTokens: 1, outputTokens: 1 } as any)
    })

    it('🔴 重現句：不再反問「哪一個商品」，用乾淨方MAX 的出貨卡答，別台的出貨卡擋掉', async () => {
      const res = await answerWithAi({ workspaceId: 'ws1', query: SHIP_NAMED, precomputedIntent: intent('question', SHIP_NAMED) })

      expect(res.disambiguation?.clarification).not.toBe(SHIP_WHICH_PRODUCT_TEXT)
      expect(res.decision).toBe('answered')
      expect(lastPrompt()).toContain('10 月中旬依照訂單順序陸續出貨')
      expect(lastPrompt()).not.toContain('第二批 11 月底')
    })

    it('🔴 正式站原句（帶「9/6下單的」＝他那一筆）→ 照 C-343 直接答出貨時程、附找真人，不轉真人', async () => {
      const res = await answerWithAi({ workspaceId: 'ws1', query: SHIP_NAMED_LIVE, precomputedIntent: intent('order_status', SHIP_NAMED_LIVE) })

      expect(res.decision).toBe('answered')
      expect(res.offerFindHuman).toBe(true)
      expect(lastPrompt()).not.toContain('第二批 11 月底')
    })

    it('只講品類「除濕機什麼時候出貨」→ 照舊先問是哪一台（共用字不會被當成指名）', async () => {
      const q = '除濕機什麼時候出貨'
      vi.mocked(searchSimilarChunks).mockResolvedValue([
        MAX_SHIP,
        card({ id: 'nwt_ship', title: '上好ㄟ抽取式除濕機', similarity: 0.77, sourceId: 'p_ship', content: '11 月初出貨。' }),
      ])
      const res = await answerWithAi({ workspaceId: 'ws1', query: q, precomputedIntent: intent('question', q) })
      expect(res.decision).toBe('disambiguate')
      expect(res.disambiguation?.clarification).toBe(SHIP_WHICH_PRODUCT_TEXT)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('① 同一份資料進 prompt 最多 3 條（以前只留 1 條）', () => {
  // 考卷 Q63 的形狀：一份說明書切成很多條，客人問的那件事排在第 2、3 條
  const MANUAL = 'p_hd7000_manual'
  const cards = [
    card({ id: 'm_material', title: '限用物質含有情況', content: '限用物質表：鉛、汞…', similarity: 0.9, sourceId: MANUAL }),
    card({ id: 'm_stick', title: '煮飯底部黏鍋', content: '黏鍋：請充分洗米、至少煮 2 杯米。', similarity: 0.82, sourceId: MANUAL }),
    card({ id: 'm_burn', title: '飯焦掉', content: '焦掉：檢查內鍋是否變形。', similarity: 0.81, sourceId: MANUAL }),
    card({ id: 'm_pack', title: '包裝內容', content: '包裝：主機、量杯、飯匙。', similarity: 0.8, sourceId: MANUAL }),
    card({ id: 'other', title: '保固說明', content: '保固一年。', similarity: 0.79, sourceId: 'p_warranty' }),
  ]
  const q = '飛利浦電子鍋煮飯但是底部整個黏鍋'

  it('🔴 同一份的前 3 條都進 prompt（黏鍋、焦掉那兩條不再被擋掉），第 4 條不進', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue(cards)
    await answerWithAi({ workspaceId: 'ws1', query: q, precomputedIntent: intent('question', q) })

    const p = lastPrompt()
    expect(p).toContain('限用物質表')
    expect(p).toContain('請充分洗米')
    expect(p).toContain('檢查內鍋是否變形')
    expect(p).not.toContain('主機、量杯、飯匙')
    // 別份資料照常進來
    expect(p).toContain('保固一年')
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('② 型號命中：答題端把這句的向量交出去，讓型號那幾條照相似度挑', () => {
  it('searchChunksByIdentifierTag 收到這句的向量', async () => {
    const q = '您好 想請問飛利浦HD7000 煮飯但是底部整個黏鍋⋯'
    await answerWithAi({ workspaceId: 'ws1', query: q, precomputedIntent: intent('question', q) })

    const call = vi.mocked(searchChunksByIdentifierTag).mock.calls[0]!
    expect(call[2]).toBe(q)
    expect(call[4]).toEqual([0.1, 0.2, 0.3])
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('③「客人在講他自己那一筆」補詞', () => {
  const Q06 = '已申請退貨，咖啡機貴公司也已收回，請問是否已退款'

  it('🔴 新補的說法都認得', () => {
    for (const t of [
      Q06,
      '已申請退貨了，退款什麼時候會到',
      '東西已收回了嗎',
      '請問是否已退款',
      '請問是否已出貨',
      SHIP_NAMED_LIVE,
      '我10月1號下單的什麼時候到',
      '9/6 買的什麼時候寄',
    ]) expect(mentionsOwnOrder(t), t).toBe(true)
  })

  it('⛔ 規則問法照舊不認（這張表放行的是轉真人）', () => {
    for (const t of [
      '9/30前下單有優惠嗎',
      '申請退貨後多久退款',
      '下單後幾天出貨',
      '請問下訂後多久會收到？',
      '退款要幾天',
    ]) expect(mentionsOwnOrder(t), t).toBe(false)
  })

  it('🔴 考卷 Q06：分類器判「查他那一筆」→ 不再被退回一般問題，答完轉真人', async () => {
    vi.mocked(generateJson).mockResolvedValueOnce({
      data: { scriptId: null, intent: 'order_status', isFollowup: false, standaloneQuery: Q06, compareItems: [], subQuestions: [] },
      inputTokens: 5, outputTokens: 5,
    } as any)
    const route = await routeMessage(Q06, [])
    expect(route?.intent).toBe('order_status')
    expect(route?.orderStatusDemoted).toBeFalsy()

    // MYFEEL 的敏感詞清單沒有「退款」（預設有）——正式站這題是走到答題才答錯的
    vi.mocked(getAiSettings).mockResolvedValue(normalizeAiSettings({ enabled: true, systemPrompt: '你是客服', shopUrl: '', sensitiveTopics: [] }))
    vi.mocked(searchSimilarChunks).mockResolvedValue([
      card({ id: 'refund', title: '退款多久會入帳?', content: '受理日 26～5 號當月 25 日退款。', similarity: 0.8 }),
    ])
    vi.mocked(generateJson).mockResolvedValue({ data: { answer: '退款排程是…', hasInfo: true }, inputTokens: 1, outputTokens: 1 } as any)
    const res = await answerWithAi({ workspaceId: 'ws1', query: Q06, precomputedIntent: route! })
    expect(res.decision).toBe('handoff')
    expect(res.handoffReason).toBe('order_status')
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('⑤ 「好的」「收到」、看不懂的字：不查知識、不硬答（AI 不回）', () => {
  /** 正式站 10/19 12:44 那場：真人客服剛回完出貨時間（沒在問問題） */
  const HUMAN_SAID: AiChatTurn = { role: 'bot', text: '您好，已協助詢問廠商，預計是10/19號這周才會開始依照訂單順序進行出貨作業', speaker: 'human' }
  const LIVE_HISTORY: AiChatTurn[] = [
    { role: 'user', text: '想詢問出貨的時間' },
    { role: 'user', text: '乾淨方Max' },
    HUMAN_SAID,
  ]
  const MAX_ORIGIN = card({ id: 'max_origin', title: 'SHARP 乾淨方MAX 產地', productName: MAX, similarity: 0.78, content: '產地：中國。' })

  beforeEach(() => {
    // 補了商品名再查，什麼都撈得到乾淨方MAX 的卡（正式站就是這樣答出「產地是中國」）
    vi.mocked(searchSimilarChunks).mockResolvedValue([MAX_ORIGIN])
    vi.mocked(generateJson).mockResolvedValue({ data: { answer: 'SHARP 乾淨方MAX 的產地是中國。', hasInfo: true }, inputTokens: 1, outputTokens: 1 } as any)
  })

  it('isAcknowledgementOnly：純回應才算', () => {
    for (const t of ['好的', '好', '收到', 'OK', 'ok～', '好的，收到', '了解了', '知道了', '嗯嗯', '可以', '👍', '好的👌', '收到 🙏']) {
      expect(isAcknowledgementOnly(t), t).toBe(true)
    }
    for (const t of ['OK?', '好的那運費呢', '謝謝', '好的謝謝', '可以退貨嗎', '收到了嗎', '好喔，那什麼時候出貨', '']) {
      expect(isAcknowledgementOnly(t), t).toBe(false)
    }
  })

  it('looksLikeZhuyinTypo：只認注音輸入法沒切到中文打出來的英數', () => {
    // 收到、到、我是、你好
    for (const t of ['g. 2l4', '2l4', 'ji3 g4', 'ji3g4', 'su3cl3']) expect(looksLikeZhuyinTypo(t), t).toBe(true)
    // 正式知識庫實測 AI 答得出來的短字（app、usb）、型號片段（GL、AP8、HD7）、訂單編號、一般英文、中文、沒有聲調鍵的
    for (const t of [
      'app', 'APP', 'usb', 'GL', 'AP8', 'HD7', 'W1', 'AI', 'wifi', 'ok', 'OK?',
      'M20261007002452KOYK', 'DW-UX22FT', 'HD7000', 'BOYA mini2', 'iBarista', '你好', '好的', '???', '😂', '24', '',
    ]) {
      expect(looksLikeZhuyinTypo(t), t).toBe(false)
    }
  })

  it('🔴 「好的」（上一則是客人自己打的亂碼，分類器把婉拒退回成問題）→ 不回、不查知識、不扣則數', async () => {
    const res = await answerWithAi({
      workspaceId: 'ws1', query: '好的',
      history: [...LIVE_HISTORY, { role: 'user', text: 'g. 2l4' }],
      precomputedIntent: intent('question', '好的'),
    })

    expect(res.decision).toBe('skipped')
    expect(res.answer).toBe('')
    expect(vi.mocked(searchSimilarChunks)).not.toHaveBeenCalled()
    expect(vi.mocked(generateJson)).not.toHaveBeenCalled()
    // 只記 token：不算一次 AI 介入、不算答出、不扣則數
    expect(deltas().every(d => !d.invocations && !d.answered && !d.billable && !d.handoffs)).toBe(true)
  })

  it('🔴 「g. 2l4」（這句自己撈不到東西、補了商品名才撈得到）→ 不回，不拿乾淨方MAX 的卡硬答', async () => {
    // 第一次＝這句自己查；第二次＝補了「（SHARP「乾淨方MAX」）」再查
    vi.mocked(searchSimilarChunks)
      .mockResolvedValueOnce([{ ...MAX_ORIGIN, similarity: 0.6 }])
      .mockResolvedValue([MAX_ORIGIN])
    const res = await answerWithAi({ workspaceId: 'ws1', query: 'g. 2l4', history: LIVE_HISTORY, precomputedIntent: intent('question', 'g. 2l4') })

    expect(res.decision).toBe('skipped')
    expect(vi.mocked(generateJson)).not.toHaveBeenCalled()
    expect(deltas().every(d => !d.invocations && !d.answered && !d.billable)).toBe(true)
  })

  it('客人在回答客服的具體問題（「您是想了解粒粒安嗎？」→「好的」）→ 那是答案，照常查', async () => {
    await answerWithAi({
      workspaceId: 'ws1', query: '好的',
      history: [{ role: 'bot', text: '您是想了解「粒粒安 飛利浦 IH 智慧電子鍋」嗎？可以點下方按鈕，或改由真人為您服務 😊' }],
      precomputedIntent: intent('question', '我想了解粒粒安'),
    })
    expect(vi.mocked(searchSimilarChunks)).toHaveBeenCalled()
  })

  it('長得像打錯的注音、但這句自己就撈得到夠像的知識 → 照常答（不是看不懂）', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue([{ ...MAX_ORIGIN, similarity: 0.8 }])
    const res = await answerWithAi({ workspaceId: 'ws1', query: 'mp3', precomputedIntent: intent('question', 'mp3') })
    expect(looksLikeZhuyinTypo('mp3')).toBe(true)
    expect(res.decision).not.toBe('skipped')
    expect(vi.mocked(generateJson)).toHaveBeenCalled()
  })

  it('長得像打錯的注音、但點名了商品 → 照常答', async () => {
    vi.mocked(searchSimilarChunks).mockResolvedValue([{ ...MAX_ORIGIN, similarity: 0.6 }])
    vi.mocked(getWorkspaceProductNames).mockResolvedValue([...NAMES, 'MP3 隨身聽'])
    const res = await answerWithAi({ workspaceId: 'ws1', query: 'mp3', precomputedIntent: intent('question', 'mp3') })
    expect(res.decision).not.toBe('skipped')
  })

  it('「謝謝」照舊回不客氣（道謝的固定回覆不變）', async () => {
    const res = await answerWithAi({ workspaceId: 'ws1', query: '謝謝', history: LIVE_HISTORY, precomputedIntent: intent('thanks', '謝謝') })
    expect(res.decision).toBe('answered')
    expect(res.answer).toContain('不客氣')
  })
})
