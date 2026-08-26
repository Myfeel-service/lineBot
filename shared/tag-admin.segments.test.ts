import { describe, expect, it } from 'vitest'
import { isAiJudgedTag, isTagAiFilterValue, TAG_AI_SEGMENTS, TAG_AI_SUB_SEGMENTS, tagSegmentCounts } from './tag-admin'

describe('AI 分段：一顆標籤算不算「AI 判斷中」', () => {
  it('suggest 與 auto 都算', () => {
    expect(isAiJudgedTag({ aiMode: 'suggest' })).toBe(true)
    expect(isAiJudgedTag({ aiMode: 'auto' })).toBe(true)
  })

  it('⛔ 缺欄位／off／亂值都不算——舊標籤沒有 aiMode，誤判會讓 21 顆全被算成 AI 判斷中', () => {
    expect(isAiJudgedTag({})).toBe(false)
    expect(isAiJudgedTag({ aiMode: undefined })).toBe(false)
    expect(isAiJudgedTag({ aiMode: null })).toBe(false)
    expect(isAiJudgedTag({ aiMode: 'off' })).toBe(false)
    expect(isAiJudgedTag({ aiMode: '亂寫' })).toBe(false)
  })
})

describe('AI 分段：膠囊上的數字', () => {
  const tags = [
    { aiMode: 'suggest' }, { aiMode: 'suggest' }, { aiMode: 'auto' },
    { aiMode: 'off' }, {}, { aiMode: undefined },
  ]

  it('三段加起來要等於總數（不然畫面上的數字對不起來）', () => {
    const c = tagSegmentCounts(tags)
    expect(c).toEqual({ all: 6, ai: 3, manual: 3, suggest: 2, auto: 1 })
    expect(c.ai + c.manual).toBe(c.all)
  })

  it('空清單不炸', () => {
    expect(tagSegmentCounts([])).toEqual({ all: 0, ai: 0, manual: 0, suggest: 0, auto: 0 })
  })

  /**
   * ⛔ 分面篩選的通則：每一面的計數要**排除它自己**。
   * 呼叫端如果把「已套 aiMode 篩選」的清單傳進來，點了「AI 判斷中」之後
   * 「手動／系統」會顯示 0，看起來像那些標籤消失了。這條把契約釘住。
   */
  it('傳進來的清單若已被 aiMode 濾過，數字就會說謊——契約是「套其他條件、不套 aiMode」', () => {
    const onlyAi = tags.filter(isAiJudgedTag)
    expect(tagSegmentCounts(onlyAi)).toEqual({ all: 3, ai: 3, manual: 0, suggest: 2, auto: 1 })
  })
})

describe('AI 分段的選項', () => {
  it('三段：全部／AI 判斷中／手動系統，值對得上 API 收的參數', () => {
    expect(TAG_AI_SEGMENTS.map(s => s.value)).toEqual(['', 'ai', 'off'])
  })
})

/**
 * 「AI 直接貼」（判到就貼、不用人點頭）是風險最高的一種——貼錯的下游是推播發錯人。
 * 先前要盤點它只能自己翻完整份清單一列一列看徽章：上面那排膠囊把 suggest 與 auto
 * 算在同一堆，而程式碼註解卻寫著「深連結不受影響」（那一頁根本沒讀網址參數）。
 */
describe('進了「AI 判斷中」之後的細分', () => {
  it('細分的兩段加起來要等於「AI 判斷中」那一顆的數字', () => {
    const c = tagSegmentCounts([
      { aiMode: 'suggest' }, { aiMode: 'auto' }, { aiMode: 'auto' }, { aiMode: 'off' },
    ])
    expect(c.suggest + c.auto).toBe(c.ai)
    expect(c.auto).toBe(2)
  })

  it('兩段的值要對得上 API 收的參數（對不上的話點了會篩出一片空白）', () => {
    expect(TAG_AI_SUB_SEGMENTS.map(s => s.value)).toEqual(['suggest', 'auto'])
  })

  it('每一段都要有講清楚風險的說明（「直接貼」那段尤其）', () => {
    const auto = TAG_AI_SUB_SEGMENTS.find(s => s.value === 'auto')!
    expect(auto.hint).toContain('不用人點頭')
  })
})

describe('?aiMode= 深連結認得的值', () => {
  it('四個值都認：兩顆主膠囊 ai/off ＋ 兩個細分 suggest/auto', () => {
    for (const v of ['ai', 'off', 'suggest', 'auto']) expect(isTagAiFilterValue(v)).toBe(true)
  })

  it('⛔ 認不得的一律當沒帶——打錯字會篩出一片空白，看起來像「一顆都沒有」', () => {
    for (const v of ['', 'AUTO', '亂寫', undefined, null, 0]) expect(isTagAiFilterValue(v)).toBe(false)
  })
})
