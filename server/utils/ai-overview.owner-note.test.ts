/**
 * `C-369`：總覽分兩段——商品清單跟著資料重做、店家自己寫的那段留著。
 * 案例是 MYFEEL 首頁那張總覽的原文（2026-07-31 手改過，「目前有賣的商品」停在 7 月）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ai-knowledge-chunker', async importOriginal => ({
  splitOwnerNoteSentences: (await importOriginal<typeof import('./ai-knowledge-chunker')>()).splitOwnerNoteSentences,
  pickOwnerNoteSentences: vi.fn(),
  summarizeAsOverviewCard: vi.fn(async () => ({
    card: { title: 'MYFEEL 商品總覽', content: '重點：家電（除濕機、咖啡機）\n\n我們主要販售各式家電。', tags: [], questions: [] },
    inputTokens: 10,
    outputTokens: 5,
  })),
}))
vi.mock('./ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  buildChunkSoftDeletePatch: () => ({ isDeleted: true }),
  createKnowledgeChunk: vi.fn(async () => {}),
  updateKnowledgeChunk: vi.fn(async () => {}),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('./ai-knowledge-quota', () => ({
  assertKnowledgeChunkQuota: vi.fn(async () => {}),
  invalidateKnowledgeChunkCount: vi.fn(),
}))

const { regenerateOverviewCard, composeOverviewContent, ownerNoteSentenceLines } = await import('./ai-overview')
const { pickOwnerNoteSentences, splitOwnerNoteSentences } = await import('./ai-knowledge-chunker')
const { updateKnowledgeChunk } = await import('./ai-knowledge-chunks')
const { writeAuditLog } = await import('./audit-log')

const MYFEEL_MANUAL = '重點：商品清單（有賣什麼 / 全部商品）｜類別（家電、生活、寵物、影音配件）｜客戶服務（保固、售後、LINE 官方帳號、支援中心）\n\n'
  + 'MYFEEL 是亞洲跨國群眾集資平台，提供群眾集資專案與產品館服務。目前有賣的商品如下：SHARP 小獴友 Poketomo 口袋同萌（AI 寵物機器人）、SHARP 頂級A咖 iBarista 智慧咖啡機。'
  + 'Byee 廚餘掰（廚餘處理機）募資已結束。另有新品不定期上架，完整最新品項請見官網 https://www.myfeel-tw.com/。'

let UPDATES: Array<{ id: string, payload: Record<string, unknown> }> = []
function dbWith(cards: Array<Record<string, unknown>>) {
  const q: any = {
    where: () => q,
    get: async () => ({ docs: cards.map((c, i) => ({ id: String(c.id ?? `c${i}`), data: () => c })) }),
    doc: (id: string) => ({ update: async (payload: Record<string, unknown>) => { UPDATES.push({ id, payload }) } }),
  }
  return { collection: () => q } as any
}
const child = (title: string) => ({ title, content: `${title} 的內容`, tags: [], status: 'indexed' })
const overview = (extra: Record<string, unknown>) => ({ id: 'ov', isOverview: true, status: 'indexed', content: MYFEEL_MANUAL, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  UPDATES = []
})

describe('splitOwnerNoteSentences', () => {
  it('「重點：」那行不算、其餘照句號拆', () => {
    expect(splitOwnerNoteSentences(MYFEEL_MANUAL)).toEqual([
      'MYFEEL 是亞洲跨國群眾集資平台，提供群眾集資專案與產品館服務。',
      '目前有賣的商品如下：SHARP 小獴友 Poketomo 口袋同萌（AI 寵物機器人）、SHARP 頂級A咖 iBarista 智慧咖啡機。',
      'Byee 廚餘掰（廚餘處理機）募資已結束。',
      '另有新品不定期上架，完整最新品項請見官網 https://www.myfeel-tw.com/。',
    ])
  })
})

describe('regenerateOverviewCard 分兩段（C-369）', () => {
  it('⭐ 整張手改過的舊總覽：拆一次——AI 只挑句子，商品清單換成現在的，店家的話接在最後，原文另外存', async () => {
    vi.mocked(pickOwnerNoteSentences).mockResolvedValue({ keep: [0, 3], inputTokens: 1, outputTokens: 1 })
    const out = await regenerateOverviewCard(dbWith([overview({ manuallyEditedAt: { t: 1 } }), child('乾淨方MAX'), child('小滑手')]), 'ws1', 'home')
    expect(out).toBe('updated')
    const note = 'MYFEEL 是亞洲跨國群眾集資平台，提供群眾集資專案與產品館服務。另有新品不定期上架，完整最新品項請見官網 https://www.myfeel-tw.com/。'
    expect(vi.mocked(updateKnowledgeChunk).mock.calls[0]![1].content).toBe(`重點：家電（除濕機、咖啡機）\n\n我們主要販售各式家電。\n\n${note}`)
    expect(UPDATES.find(u => u.id === 'ov')!.payload).toEqual({
      overviewAuto: '重點：家電（除濕機、咖啡機）\n\n我們主要販售各式家電。',
      ownerNote: note,
      manuallyEditedAt: null,
      legacyManualContent: MYFEEL_MANUAL,
    })
    // 系統動了店家改過的東西 → 一定記一筆
    expect(vi.mocked(writeAuditLog).mock.calls[0]![0]).toMatchObject({ actor: 'system', targetId: 'ov' })
  })

  it('⛔ AI 挑句子掛了 → 照舊保留整張、什麼都不改（寧可清單舊，也不弄丟店家的字）', async () => {
    vi.mocked(pickOwnerNoteSentences).mockRejectedValue(new Error('gemini down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await regenerateOverviewCard(dbWith([overview({ manuallyEditedAt: { t: 1 } }), child('A'), child('B')]), 'ws1', 'home')
    expect(out).toBe('kept_manual')
    expect(updateKnowledgeChunk).not.toHaveBeenCalled()
    expect(UPDATES).toEqual([])
    warn.mockRestore()
  })

  it('拆過的：店家的話照用、不再問 AI 挑句子', async () => {
    const out = await regenerateOverviewCard(dbWith([overview({ manuallyEditedAt: null, ownerNote: '客服請找 LINE 官方帳號。' }), child('A'), child('B')]), 'ws1', 'home')
    expect(out).toBe('updated')
    expect(pickOwnerNoteSentences).not.toHaveBeenCalled()
    expect(vi.mocked(updateKnowledgeChunk).mock.calls[0]![1].content).toBe('重點：家電（除濕機、咖啡機）\n\n我們主要販售各式家電。\n\n客服請找 LINE 官方帳號。')
  })

  it('整張系統做的：只有系統那段', async () => {
    await regenerateOverviewCard(dbWith([overview({ manuallyEditedAt: null, content: '舊的清單' }), child('A'), child('B')]), 'ws1', 'home')
    expect(vi.mocked(updateKnowledgeChunk).mock.calls[0]![1].content).toBe('重點：家電（除濕機、咖啡機）\n\n我們主要販售各式家電。')
    expect(UPDATES.find(u => u.id === 'ov')!.payload).toMatchObject({ ownerNote: '', manuallyEditedAt: null })
  })

  it('⛔ 留下的句子原本在不同行 → 照樣換行，不黏成一串（C-379：信箱接著電話，AI 讀到壞掉的信箱）', async () => {
    const content = `${MYFEEL_MANUAL}\n客服信箱：service@myfeel-tw.com\n客服電話：02-1234-5678\n保固一年，請保留發票。延長保固請洽客服。`
    // 跟整段切出來的句子一模一樣、順序也一樣（AI 拿到的編號才對得上）
    expect(ownerNoteSentenceLines(content).flat()).toEqual(splitOwnerNoteSentences(content))
    vi.mocked(pickOwnerNoteSentences).mockResolvedValue({ keep: [0, 4, 5, 6, 7], inputTokens: 1, outputTokens: 1 })
    await regenerateOverviewCard(dbWith([overview({ manuallyEditedAt: { t: 1 }, content }), child('A'), child('B')]), 'ws1', 'home')
    expect(UPDATES.find(u => u.id === 'ov')!.payload.ownerNote).toBe([
      'MYFEEL 是亞洲跨國群眾集資平台，提供群眾集資專案與產品館服務。',
      '客服信箱：service@myfeel-tw.com',
      '客服電話：02-1234-5678',
      '保固一年，請保留發票。延長保固請洽客服。',
    ].join('\n'))
  })

  it('子卡沒了：整張手改過、還沒拆的照舊留著（不替店家丟字）', async () => {
    const out = await regenerateOverviewCard(dbWith([overview({ manuallyEditedAt: { t: 1 } }), child('A')]), 'ws1', 'home')
    expect(out).toBe('kept_manual')
    expect(UPDATES).toEqual([])
  })

  it('composeOverviewContent：店家沒寫就只有系統那段', () => {
    expect(composeOverviewContent('清單', '')).toBe('清單')
    expect(composeOverviewContent('清單', '  介紹  ')).toBe('清單\n\n介紹')
  })
})
