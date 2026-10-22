/**
 * `C-368`：先比網頁、沒衝突就自動做完（`tryAutoApplyPageChange`）。
 * 情境照 2026-10-21 MYFEEL 首頁：首頁換了一批主打（多一個商品、少一個），AI 重寫整份之後
 * 沒動的商品變成「修改」、頁尾多寫一條——只有真的改了的那兩條要動，其他一個字都不動。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./firebase', () => ({ getDb: () => ({}) }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-knowledge-chunker', () => ({ chunkTextWithLlm: vi.fn() }))
vi.mock('./ai-knowledge-sources', () => ({
  listChunksBySource: vi.fn(),
  loadAppliedPage: vi.fn(),
  sourceNumbersVolatile: (raw: { numericDriftRounds?: number }) => Number(raw.numericDriftRounds ?? 0) >= 2,
}))
vi.mock('./ai-knowledge-resync', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-knowledge-resync')>()),
  judgeCosmeticRewrites: vi.fn(async (pairs: unknown[]) => ({ verdicts: pairs.map(() => 'unsure'), inputTokens: 0, outputTokens: 0, calls: [] })),
}))
vi.mock('./ai-knowledge-resync-apply', () => ({ applyResyncEntries: vi.fn() }))
vi.mock('./ai-overview', () => ({ regenerateOverviewCard: vi.fn(async () => 'updated') }))
vi.mock('./ai-knowledge-quota', () => ({ invalidateKnowledgeChunkCount: vi.fn() }))

const { tryAutoApplyPageChange } = await import('./ai-knowledge-autoapply')
const { chunkTextWithLlm } = await import('./ai-knowledge-chunker')
const { listChunksBySource, loadAppliedPage } = await import('./ai-knowledge-sources')
const { applyResyncEntries } = await import('./ai-knowledge-resync-apply')
const { regenerateOverviewCard } = await import('./ai-overview')

const line = (name: string, slug: string) =>
  `${name} 人數達標解鎖更多獎勵！ NT$ 0 9,895,800 / 每月 9,896 % 10 天 即將上市 0 432 人支持 / 每月 10 天（https://www.myfeel-tw.com/projects/${slug}）`
const FOOTER = '來瞭解\n關於我們（https://www.myfeel-tw.com/aboutUs）\n隱私權保護條款（https://www.myfeel-tw.com/privacy）'
const BASE = [line('SHARP 靜音無線吸塵器 EC-SR9TW', 'EC-SR9TW'), line('DEAR.min 不落枕記憶枕', 'dearminpillow'), FOOTER].join('\n')
const NOW = [line('SHARP 靜音無線吸塵器 EC-SR9TW', 'EC-SR9TW'), line('SHARP 乾淨方MAX 清淨除濕機', 'DW-UX22FT'), FOOTER].join('\n')
const card = (name: string, slug: string, body: string) => `重點：品牌：${name}\n\n${body}\n連結：https://www.myfeel-tw.com/projects/${slug}`

const oldCard = (id: string, title: string, content: string, extra: Record<string, unknown> = {}) =>
  ({ id, title, content, tags: [], questions: [], status: 'indexed', isOverview: false, manuallyEditedAtMs: 0, ...extra })
const OLD = () => [
  oldCard('sharp', 'SHARP 靜音無線吸塵器', card('SHARP', 'EC-SR9TW', 'SHARP靜音無線吸塵器，主打靜音和無線設計。')),
  oldCard('dear', 'DEAR.min 記憶枕', card('DEAR.min', 'dearminpillow', 'DEAR.min 不落枕零壓可調節深睡記憶枕。')),
]
const NEW_CHUNKS = [
  { title: 'SHARP 靜音無線吸塵器 EC-SR9TW', content: card('SHARP', 'EC-SR9TW', 'SHARP「噓塵器」靜音無線吸塵器提供兩種顏色。'), tags: [], questions: [], sourceId: null },
  { title: 'SHARP 乾淨方MAX 清淨除濕機', content: card('SHARP', 'DW-UX22FT', '這是 SHARP 的最新機種「乾淨方MAX」雙氣流智慧變頻美學清淨除濕機。'), tags: [], questions: [], sourceId: null },
  { title: 'MYFEEL關於我們', content: '您可以透過「關於我們」頁面了解MYFEEL的相關資訊。\n連結：https://www.myfeel-tw.com/aboutUs', tags: [], questions: [], sourceId: null },
]
const SOURCE = { workspaceId: 'ws1', name: 'https://www.myfeel-tw.com/', generateOverview: true, numericDriftRounds: 4 } as any
const OPTS = { takeAiSlot: () => true, autoApply: true }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadAppliedPage).mockResolvedValue({ text: BASE, hash: 'h-old' })
  vi.mocked(listChunksBySource).mockResolvedValue(OLD() as any)
  vi.mocked(chunkTextWithLlm).mockResolvedValue({ chunks: NEW_CHUNKS, inputTokens: 1, outputTokens: 1, calls: [] } as any)
  vi.mocked(applyResyncEntries).mockResolvedValue({
    added: 1, updated: 0, deleted: 1, kept: 2, quotaSkipped: 0, errors: [],
    addedTitles: ['SHARP 乾淨方MAX 清淨除濕機'], updatedTitles: [], removedTitles: ['DEAR.min 記憶枕'],
  })
})

const decisionsSent = () => {
  const arg = vi.mocked(applyResyncEntries).mock.calls[0]![1]
  const titleOf = (id: string) => {
    const e = arg.entries.find(x => x.id === id)!
    return e.newChunk?.title ?? e.oldChunk?.title
  }
  return Object.fromEntries(Object.entries(arg.decisions).map(([id, a]) => [titleOf(id), a]))
}

describe('tryAutoApplyPageChange（C-368）', () => {
  it('首頁換了一批：只新增多的、拿掉少的；沒動的商品與頁尾一個字都不動；總覽跟著換', async () => {
    const r = await tryAutoApplyPageChange({} as any, 'home', SOURCE, NOW, 'h-new', OPTS)
    expect(r).toMatchObject({ kind: 'applied', usedAi: true, fingerprintSafe: true })
    expect(decisionsSent()).toEqual({ 'SHARP 乾淨方MAX 清淨除濕機': 'add_new', 'DEAR.min 記憶枕': 'delete_old' })
    expect(regenerateOverviewCard).toHaveBeenCalledWith({}, 'ws1', 'home')
    expect(r.record).toMatchObject({ added: 1, removed: 1, updated: 0, overviewUpdated: true, removedTitles: ['DEAR.min 記憶枕'] })
  })

  it('同一版網頁、同一個標題＝同一個新知識編號（中途逾時重跑不會長出重複的）', async () => {
    await tryAutoApplyPageChange({} as any, 'home', SOURCE, NOW, 'h-new', OPTS)
    const { chunkIdFor, entries } = vi.mocked(applyResyncEntries).mock.calls[0]![1]
    const added = entries.find(e => e.kind === 'new' && e.newChunk?.title === 'SHARP 乾淨方MAX 清淨除濕機')!
    const first = chunkIdFor(added)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(chunkIdFor({ ...added, id: 'new:99' })).toBe(first)
  })

  it('沒有上一版原文（舊資料）→ legacy，不花 AI 的錢', async () => {
    vi.mocked(loadAppliedPage).mockResolvedValue(null)
    expect(await tryAutoApplyPageChange({} as any, 'home', SOURCE, NOW, 'h-new', OPTS)).toEqual({ kind: 'legacy', usedAi: false })
    expect(chunkTextWithLlm).not.toHaveBeenCalled()
  })

  it('一行都沒改（只有順序、空白）→ noop，不花 AI 的錢', async () => {
    const shuffled = [FOOTER, line('DEAR.min 不落枕記憶枕', 'dearminpillow'), `  ${line('SHARP 靜音無線吸塵器 EC-SR9TW', 'EC-SR9TW')}`].join('\n')
    expect(await tryAutoApplyPageChange({} as any, 'home', SOURCE, shuffled, 'h-new', OPTS)).toEqual({ kind: 'noop', usedAi: false })
    expect(chunkTextWithLlm).not.toHaveBeenCalled()
  })

  /**
   * `C-379`：數字會跳的網址，行都一樣、只有數字跟上一版不同。以前一律 noop＝排程把版本記號推到這一版，
   * 改了價錢、集資結束的數字從此卡上是舊的，「立即更新」又回「網頁沒有要更新的地方」。
   */
  describe('⛔ 數字會跳的網址：行都一樣、只有數字不同（C-379）', () => {
    const shuffled = [FOOTER, line('DEAR.min 不落枕記憶枕', 'dearminpillow').replace('9,895,800', '9,999,999'), line('SHARP 靜音無線吸塵器 EC-SR9TW', 'EC-SR9TW')].join('\n')

    it('數字還在跳（順序換了才走到這裡）→ numbers_drift：不花錢、⛔ 不是 noop（不推進版本記號）', async () => {
      expect(await tryAutoApplyPageChange({} as any, 'home', SOURCE, shuffled, 'h-new', OPTS)).toEqual({ kind: 'numbers_drift', usedAi: false })
      expect(chunkTextWithLlm).not.toHaveBeenCalled()
    })

    it('數字停在新的值（改價）→ 照樣請 AI 整理，只換卡上數字有變的那一條', async () => {
      const base = `早鳥價 3990 元，限量 500 台\n${FOOTER}`
      vi.mocked(loadAppliedPage).mockResolvedValue({ text: base, hash: 'h-old' })
      vi.mocked(listChunksBySource).mockResolvedValue([
        oldCard('price', '早鳥價', '早鳥價 3990 元，限量 500 台。'),
        oldCard('about', '關於我們', '透過關於我們頁面了解 MYFEEL。'),
      ] as any)
      vi.mocked(chunkTextWithLlm).mockResolvedValue({ chunks: [
        { title: '早鳥價', content: '早鳥價 4290 元，限量 500 台。', tags: [], questions: [], sourceId: null },
        { title: '關於我們', content: '可以到關於我們頁面認識 MYFEEL 平台。', tags: [], questions: [], sourceId: null },
      ], calls: [] } as any)
      vi.mocked(applyResyncEntries).mockResolvedValue({
        added: 0, updated: 1, deleted: 0, kept: 1, quotaSkipped: 0, errors: [], addedTitles: [], updatedTitles: ['早鳥價'], removedTitles: [],
      })
      const r = await tryAutoApplyPageChange({} as any, 'home', SOURCE, base.replace('3990', '4290'), 'h-new', { ...OPTS, numbersSettled: true })
      expect(r).toMatchObject({ kind: 'applied', usedAi: true })
      // 只換價錢那條；另一條是 AI 換句話說、網頁沒改，原本的不動
      expect(decisionsSent()).toEqual({ 早鳥價: 'use_new' })
    })

    it('數字停在新的值、設定成「每次都先問我」→ 講得出網頁改了幾行（逐字比的行數，不是 0）', async () => {
      const r = await tryAutoApplyPageChange({} as any, 'home', SOURCE, shuffled, 'h-new', { ...OPTS, autoApply: false, numbersSettled: true })
      expect(r).toEqual({ kind: 'manual', reason: { kind: 'ask', count: 2 }, usedAi: false })
    })
  })

  it('設定成「每次都先問我」→ 不自動，但講得出改了幾行', async () => {
    const r = await tryAutoApplyPageChange({} as any, 'home', SOURCE, NOW, 'h-new', { ...OPTS, autoApply: false })
    expect(r).toEqual({ kind: 'manual', reason: { kind: 'ask', count: 2 }, usedAi: false })
    expect(chunkTextWithLlm).not.toHaveBeenCalled()
  })

  it('這一輪請 AI 的名額用完 → needs_ai（下一輪再來）', async () => {
    expect(await tryAutoApplyPageChange({} as any, 'home', SOURCE, NOW, 'h-new', { takeAiSlot: () => false, autoApply: true }))
      .toEqual({ kind: 'needs_ai', usedAi: false })
  })

  it('⛔ 名額在真的要請 AI 那一刻才拿：一行都沒改、要人看的那幾種都不拿（C-379）', async () => {
    const takeAiSlot = vi.fn(() => true)
    await tryAutoApplyPageChange({} as any, 'home', SOURCE, BASE, 'h-new', { takeAiSlot, autoApply: true })
    await tryAutoApplyPageChange({} as any, 'home', SOURCE, NOW, 'h-new', { takeAiSlot, autoApply: false })
    expect(takeAiSlot).not.toHaveBeenCalled()
    await tryAutoApplyPageChange({} as any, 'home', SOURCE, NOW, 'h-new', { takeAiSlot, autoApply: true })
    expect(takeAiSlot).toHaveBeenCalledTimes(1)
  })

  it('網頁改了一大半 → 停下來問（多半是網站改版）', async () => {
    const big = Array.from({ length: 30 }, (_, i) => `新版第${i}行說明文字`).join('\n')
    vi.mocked(loadAppliedPage).mockResolvedValue({ text: Array.from({ length: 30 }, (_, i) => `舊版第${i}行說明文字`).join('\n'), hash: 'h' })
    // 數字不會跳的網址（會跳的網址比之前把數字抹掉，「第 1 行」「第 2 行」會變成同一行）
    const r = await tryAutoApplyPageChange({} as any, 'home', { ...SOURCE, numericDriftRounds: 0 }, big, 'h-new', OPTS)
    expect(r).toMatchObject({ kind: 'manual', reason: { kind: 'big_change' } })
    expect(chunkTextWithLlm).not.toHaveBeenCalled()
  })

  it('⛔ 抓到的網頁少了一大半 → 停下來問，不照著刪知識', async () => {
    const r = await tryAutoApplyPageChange({} as any, 'home', SOURCE, line('SHARP 靜音無線吸塵器 EC-SR9TW', 'EC-SR9TW').slice(0, 60), 'h-new', OPTS)
    expect(r).toMatchObject({ kind: 'manual', reason: { kind: 'shrink' } })
  })

  it('⛔ 網頁上拿掉的那條是你手改過的 → 停下來問，一條都不動', async () => {
    vi.mocked(listChunksBySource).mockResolvedValue([OLD()[0], { ...OLD()[1], manuallyEditedAtMs: 1 }] as any)
    const r = await tryAutoApplyPageChange({} as any, 'home', SOURCE, NOW, 'h-new', OPTS)
    expect(r).toEqual({ kind: 'manual', reason: { kind: 'manual_edit', count: 1 }, usedAi: true })
    expect(applyResyncEntries).not.toHaveBeenCalled()
  })

  it('⛔ 網頁改了的那一條是停用中的 → 停下來問（自動改寫會讓過期的卡復活）', async () => {
    const base = '本店提供七天鑑賞期，商品需保持完整包裝，退貨請先聯絡客服。\n'.repeat(1) + FOOTER
    const now = '本店提供十天鑑賞期，商品需保持完整包裝，退貨請先聯絡客服。\n' + FOOTER
    vi.mocked(loadAppliedPage).mockResolvedValue({ text: base, hash: 'h' })
    vi.mocked(listChunksBySource).mockResolvedValue([oldCard('ret', '退貨', '本店提供七天鑑賞期，商品需保持完整包裝，退貨請先聯絡客服。', { status: 'disabled' })] as any)
    vi.mocked(chunkTextWithLlm).mockResolvedValue({ chunks: [{ title: '退貨', content: '本店提供十天鑑賞期，商品需保持完整包裝，退貨請先聯絡客服。', tags: [], questions: [], sourceId: null }], calls: [] } as any)
    const r = await tryAutoApplyPageChange({} as any, 'faq', { ...SOURCE, generateOverview: false, numericDriftRounds: 0 }, now, 'h-new', OPTS)
    expect(r).toEqual({ kind: 'manual', reason: { kind: 'disabled', count: 1 }, usedAi: true })
  })

  it('⛔ 改了的行對不到任何知識 → 停下來問', async () => {
    const base = '本店提供七天鑑賞期，商品需保持完整包裝，退貨請先聯絡客服。\n' + FOOTER
    const now = '本店提供七天鑑賞期，拆封後的耳機類商品恕不退貨，退貨請先聯絡客服。\n' + FOOTER
    vi.mocked(loadAppliedPage).mockResolvedValue({ text: base, hash: 'h' })
    vi.mocked(listChunksBySource).mockResolvedValue([oldCard('ret', '退貨', '我們提供七天鑑賞期，退貨前請先聯絡客服。')] as any)
    vi.mocked(chunkTextWithLlm).mockResolvedValue({ chunks: [{ title: '退貨', content: '我們提供七天鑑賞期，退貨前請先聯絡客服。', tags: [], questions: [], sourceId: null }], calls: [] } as any)
    const r = await tryAutoApplyPageChange({} as any, 'faq', { ...SOURCE, generateOverview: false, numericDriftRounds: 0 }, now, 'h-new', OPTS)
    expect(r).toMatchObject({ kind: 'manual', reason: { kind: 'unclaimed' } })
    expect(applyResyncEntries).not.toHaveBeenCalled()
  })

  it('空間不夠沒加完 → applied 但不算對到這一版，帶 quota 原因', async () => {
    vi.mocked(applyResyncEntries).mockResolvedValue({
      added: 0, updated: 0, deleted: 1, kept: 2, quotaSkipped: 1, errors: [],
      addedTitles: [], updatedTitles: [], removedTitles: ['DEAR.min 記憶枕'],
    })
    const r = await tryAutoApplyPageChange({} as any, 'home', SOURCE, NOW, 'h-new', OPTS)
    expect(r).toMatchObject({ kind: 'applied', fingerprintSafe: false, reason: { kind: 'quota', count: 1 } })
  })
})
