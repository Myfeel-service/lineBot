import { describe, expect, it } from 'vitest'
import {
  buildInferPrompt,
  describeInferSources,
  hasEnoughToInfer,
  type InferSources,
} from './store-profile-infer'
import { aiGuessableFields } from './store-profile-extract'

function sourcesOf(over: Partial<InferSources> = {}): InferSources {
  return {
    workspaceName: '山丘咖啡',
    chunkTitles: ['黑豆水 500ml', '養生茶包 30 入', '出貨與退換貨說明'],
    questions: ['可以貨到付款嗎', '什麼時候出貨'],
    tagNames: ['問卷 - 中秋禮盒', '客服 - 退換貨'],
    campaignNames: ['中秋禮盒預購'],
    truncated: [],
    ...over,
  }
}

describe('hasEnoughToInfer', () => {
  it('什麼都沒有時不要硬猜', () => {
    expect(hasEnoughToInfer(sourcesOf({ chunkTitles: [], tagNames: [], campaignNames: [] }))).toBe(false)
  })
  it('湊得到三筆就可以猜', () => {
    expect(hasEnoughToInfer(sourcesOf({ chunkTitles: ['A'], tagNames: ['B'], campaignNames: ['C'] }))).toBe(true)
  })
  it('⛔ 只有問法不算數（問法是從卡片長出來的，沒有卡片就不會有問法）', () => {
    expect(hasEnoughToInfer(sourcesOf({ chunkTitles: [], tagNames: [], campaignNames: [], questions: ['a', 'b', 'c', 'd'] }))).toBe(false)
  })
})

describe('buildInferPrompt', () => {
  it('把四類資料都寫進去', () => {
    const p = buildInferPrompt(sourcesOf())
    expect(p).toContain('山丘咖啡')
    expect(p).toContain('黑豆水 500ml')
    expect(p).toContain('可以貨到付款嗎')
    expect(p).toContain('問卷 - 中秋禮盒')
    expect(p).toContain('中秋禮盒預購')
  })

  it('要填的欄位跟讀網站那支是同一組（兩邊各一份會慢慢飄）', () => {
    const p = buildInferPrompt(sourcesOf())
    for (const f of aiGuessableFields()) expect(p, f.id).toContain(`"${f.id}"`)
    expect(p).not.toContain('"season"')
    expect(p).not.toContain('"pain"')
  })

  it('⛔ 一定要寫「看不出來的就回空字串」', () => {
    expect(buildInferPrompt(sourcesOf())).toContain('看不出來的就回空字串')
  })

  it('某一類是空的時候不會留下一個空標題', () => {
    const p = buildInferPrompt(sourcesOf({ campaignNames: [], tagNames: [] }))
    expect(p).not.toContain('他們建過的標籤：')
    expect(p).not.toContain('他們辦過的活動：')
  })
})

describe('describeInferSources', () => {
  it('講得出看了哪些東西', () => {
    const t = describeInferSources(sourcesOf())
    expect(t).toContain('知識庫 3 筆')
    expect(t).toContain('2 顆標籤')
    expect(t).toContain('1 個活動')
  })

  it('⛔ 撞上限一定要講（不可以把「前 60 張」說成「全部」）', () => {
    const t = describeInferSources(sourcesOf({ truncated: ['知識卡'] }))
    expect(t).toContain('不是全部')
    expect(t).toContain('知識卡')
  })

  it('查不到時講得出「資料不夠」而不是講成看過了', () => {
    const t = describeInferSources(sourcesOf({ chunkTitles: [], questions: [], tagNames: [], campaignNames: [] }))
    expect(t).toContain('還沒有足夠的資料')
  })
})
