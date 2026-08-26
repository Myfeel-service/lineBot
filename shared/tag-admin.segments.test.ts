import { describe, expect, it } from 'vitest'
import { isAiJudgedTag, TAG_AI_SEGMENTS, tagSegmentCounts } from './tag-admin'

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
    expect(c).toEqual({ all: 6, ai: 3, manual: 3 })
    expect(c.ai + c.manual).toBe(c.all)
  })

  it('空清單不炸', () => {
    expect(tagSegmentCounts([])).toEqual({ all: 0, ai: 0, manual: 0 })
  })

  /**
   * ⛔ 分面篩選的通則：每一面的計數要**排除它自己**。
   * 呼叫端如果把「已套 aiMode 篩選」的清單傳進來，點了「AI 判斷中」之後
   * 「手動／系統」會顯示 0，看起來像那些標籤消失了。這條把契約釘住。
   */
  it('傳進來的清單若已被 aiMode 濾過，數字就會說謊——契約是「套其他條件、不套 aiMode」', () => {
    const onlyAi = tags.filter(isAiJudgedTag)
    expect(tagSegmentCounts(onlyAi)).toEqual({ all: 3, ai: 3, manual: 0 })
  })
})

describe('AI 分段的選項', () => {
  it('三段：全部／AI 判斷中／手動系統，值對得上 API 收的參數', () => {
    expect(TAG_AI_SEGMENTS.map(s => s.value)).toEqual(['', 'ai', 'off'])
  })
})
