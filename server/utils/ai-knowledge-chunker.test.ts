import { beforeEach, describe, expect, it, vi } from 'vitest'

// 只 mock LLM 呼叫本身，批次切分 / 索引對齊邏輯走真的
vi.mock('./gemini', () => ({
  generateJson: vi.fn(),
  generateParts: vi.fn(),
}))

import { generateJson } from './gemini'
import { ENRICH_BATCH_SIZE, enrichCardBatch, enrichCardsWithLlm, needsQuestionEnrichment, stripBoilerplate } from './ai-knowledge-chunker'

const mockGen = vi.mocked(generateJson)

const card = (i: number) => ({ title: `Q${i}`, content: `A${i}` })

beforeEach(() => {
  mockGen.mockReset()
})

describe('enrichCardBatch', () => {
  it('空輸入直接回空、不打 LLM', async () => {
    const res = await enrichCardBatch([])
    expect(res).toEqual({ items: [], inputTokens: 0, outputTokens: 0 })
    expect(mockGen).not.toHaveBeenCalled()
  })

  it('照 index 對齊回輸入順序；漏答的位置為空陣列', async () => {
    mockGen.mockResolvedValue({
      data: {
        cards: [
          // 順序故意亂 + 漏掉 index 1 + 一個超界 index
          { index: 2, questions: ['q2a', 'q2b'], tags: ['t2'] },
          { index: 0, questions: ['q0'], tags: ['t0'] },
          { index: 9, questions: ['ghost'], tags: [] },
        ],
      },
      inputTokens: 10,
      outputTokens: 20,
    })
    const res = await enrichCardBatch([card(0), card(1), card(2)])
    expect(res.items).toEqual([
      { questions: ['q0'], tags: ['t0'] },
      { questions: [], tags: [] },
      { questions: ['q2a', 'q2b'], tags: ['t2'] },
    ])
    expect(res.inputTokens).toBe(10)
    expect(res.outputTokens).toBe(20)
  })

  it('index 為 null/非數字不會被 Number() 轉成 0 而洗掉 items[0]', async () => {
    mockGen.mockResolvedValue({
      data: {
        cards: [
          { index: null, questions: ['壞資料'], tags: [] }, // Number(null)===0 → 不可洗掉 items[0]
          { index: 0, questions: ['正解'], tags: ['t'] },
          { index: 0, questions: ['重複 index 應被忽略'], tags: [] }, // 重複 → 只認第一筆
        ],
      },
      inputTokens: 1,
      outputTokens: 1,
    })
    const res = await enrichCardBatch([card(0), card(1)])
    expect(res.items[0]).toEqual({ questions: ['正解'], tags: ['t'] })
    expect(res.items[1]).toEqual({ questions: [], tags: [] })
  })

  it('questions 截到 3 句、tags 截到 2 個、空白項過濾', async () => {
    mockGen.mockResolvedValue({
      data: {
        cards: [{ index: 0, questions: ['a', ' ', 'b', 'c', 'd'], tags: ['x', '', 'y', 'z'] }],
      },
      inputTokens: 1,
      outputTokens: 1,
    })
    const res = await enrichCardBatch([card(0)])
    expect(res.items[0]).toEqual({ questions: ['a', 'b', 'c'], tags: ['x', 'y'] })
  })
})

describe('enrichCardsWithLlm', () => {
  it(`超過 ${ENRICH_BATCH_SIZE} 張切成多批，結果照序合併、token 加總`, async () => {
    mockGen.mockImplementation(async (prompt: string) => {
      // 每批對每張卡回一個固定問法；從 prompt 反推該批卡數
      const count = (prompt.match(/^\[\d+\] 標題/gm) ?? []).length
      return {
        data: {
          cards: Array.from({ length: count }, (_, i) => ({
            index: i,
            questions: [`q-${i}`],
            tags: ['t'],
          })),
        },
        inputTokens: 5,
        outputTokens: 7,
      }
    })
    const cards = Array.from({ length: ENRICH_BATCH_SIZE + 3 }, (_, i) => card(i))
    const res = await enrichCardsWithLlm(cards)
    expect(mockGen).toHaveBeenCalledTimes(2)
    expect(res.items).toHaveLength(cards.length)
    expect(res.items.every(it => it.questions.length === 1)).toBe(true)
    expect(res.inputTokens).toBe(10)
    expect(res.outputTokens).toBe(14)
  })

  it('單批失敗不擋整體：該批空陣列、其他批照常', async () => {
    let call = 0
    mockGen.mockImplementation(async () => {
      call += 1
      if (call === 1) throw new Error('boom')
      return {
        data: { cards: [{ index: 0, questions: ['ok'], tags: [] }] },
        inputTokens: 3,
        outputTokens: 4,
      }
    })
    const cards = Array.from({ length: ENRICH_BATCH_SIZE + 1 }, (_, i) => card(i))
    const res = await enrichCardsWithLlm(cards)
    expect(res.items).toHaveLength(cards.length)
    // 第一批（前 15 張）全空
    expect(res.items.slice(0, ENRICH_BATCH_SIZE).every(it => !it.questions.length)).toBe(true)
    // 第二批第一張有補到
    expect(res.items[ENRICH_BATCH_SIZE]).toEqual({ questions: ['ok'], tags: [] })
    expect(res.inputTokens).toBe(3)
    expect(res.outputTokens).toBe(4)
  })
})

describe('stripBoilerplate', () => {
  it('定義卡保留定義句、剝除黏在後面的免責樣板（本案 Poketomo）', () => {
    const input = [
      '重點：Poketomo｜SRC01TWW 主機簡稱',
      '',
      'Poketomo 是 SRC01TWW 主機的簡稱。本產品功能將持續升級，故本指南中之畫面、功能及操作步驟可能有所變更，畫面及插圖僅供示意，可能與實際產品有所差異。本指南內容及官方網站網址如有變更，恕不另行通知。',
    ].join('\n')
    const out = stripBoilerplate(input)
    expect(out).toContain('Poketomo 是 SRC01TWW 主機的簡稱。')
    expect(out).toContain('重點：Poketomo｜SRC01TWW 主機簡稱') // 結構行原樣保留
    expect(out).not.toMatch(/恕不另行通知|僅供示意|與實際產品|操作步驟可能有所變更/)
  })

  it('也剝除口語改寫版的免責句', () => {
    const input = 'Poketomo是SRC01TWW主機的簡稱喔！它的功能會持續升級，所以指南中的畫面、功能和操作步驟可能會有所變更，畫面和插圖也都是示意圖。指南內容和官方網站網址如有變更，恕不另行通知喔。'
    const out = stripBoilerplate(input)
    expect(out).toBe('Poketomo是SRC01TWW主機的簡稱喔！')
  })

  it('純免責卡剝完變空字串（呼叫端會丟棄）', () => {
    const input = '本手冊畫面僅供示意，可能與實際產品有所差異。內容如有變更，恕不另行通知。版權所有 翻印必究。'
    expect(stripBoilerplate(input)).toBe('')
  })

  it('剝除版權／商標宣告', () => {
    expect(stripBoilerplate('售後服務請洽客服。© 2026 品牌保留所有權利。')).toBe('售後服務請洽客服。')
    expect(stripBoilerplate('Poketomo 為 XYZ 公司之註冊商標。')).toBe('')
  })

  it('不誤刪正常內容（高辨識標記才刪）', () => {
    const keep = [
      '退貨後款項會在 7 個工作天內退回原付款方式。',
      '這台主機的功能會持續升級，未來會新增更多玩法。', // 「持續升級」是賣點、無免責標記 → 保留
      '示意圖如下，實際顏色以現貨為準。', // 未帶「與實際／僅供示意」硬標記 → 保留
    ].join('\n')
    expect(stripBoilerplate(keep)).toBe(keep)
  })

  /**
   * 2026-08-11 拿正式站卡片實測抓到的誤刪：裸配「僅供參考」會吃掉真操作說明。
   * 「僅供參考」必須綁圖像主詞（畫面／插圖／圖片…）才算免責句；把這條放寬回去就會再犯。
   */
  it('⛔「僅供參考」出現在操作說明裡要保留，綁圖像主詞才是免責', () => {
    const keep = [
      '加水時，請根據米的種類與品質調整水量，內鍋水位刻度僅供參考。',
      '飯碗容量以 265ml 為參考值，容量僅供參考。',
    ].join('\n')
    expect(stripBoilerplate(keep)).toBe(keep)
    // 圖像免責照樣剝掉
    expect(stripBoilerplate('產品外觀請見官網，圖片僅供參考。')).toBe('')
    expect(stripBoilerplate('本頁畫面僅供示意。')).toBe('')
  })

  it('空輸入回空字串', () => {
    expect(stripBoilerplate('')).toBe('')
    expect(stripBoilerplate('   ')).toBe('')
  })
})

describe('needsQuestionEnrichment', () => {
  const base = { title: '退款', content: '3 天' }

  it('沒問法、非人工、非總覽、有 title/content → 要補', () => {
    expect(needsQuestionEnrichment({ ...base, questions: [] })).toBe(true)
    expect(needsQuestionEnrichment({ ...base })).toBe(true) // questions 欄位不存在
    expect(needsQuestionEnrichment({ ...base, questions: ['  '] })).toBe(true) // 只有空白也算沒問法
  })

  it('已有問法 → 不補', () => {
    expect(needsQuestionEnrichment({ ...base, questions: ['錢什麼時候退?'] })).toBe(false)
  })

  it('人工編輯過 / 總覽卡 → 不補', () => {
    expect(needsQuestionEnrichment({ ...base, questions: [], manuallyEditedAt: { seconds: 1 } })).toBe(false)
    expect(needsQuestionEnrichment({ ...base, questions: [], isOverview: true })).toBe(false)
  })

  it('title 或 content 為空 → 沒東西可餵，跳過', () => {
    expect(needsQuestionEnrichment({ title: '', content: '3 天', questions: [] })).toBe(false)
    expect(needsQuestionEnrichment({ title: '退款', content: '', questions: [] })).toBe(false)
  })
})
