import { describe, expect, it } from 'vitest'
import { bucketAiCosts, usdForTokens } from './ai-cost-buckets'

/**
 * 這組測試守的是 2026-08-10 稽核出來的記帳約定：
 * 三桶相加必須剛好等於「全部 token 的錢」——多算（重複計）或少算（漏桶）在畫面上
 * 都只會變成一個看起來很合理的數字，沒有測試就抓不到。
 */
describe('bucketAiCosts', () => {
  it('三桶相加＝全部 token 的錢（不重複算、不漏算）', () => {
    const u = {
      inputTokens: 504_127, outputTokens: 65_770, embeddingTokens: 9125,
      importInputTokens: 46_997, importOutputTokens: 37_957, buildEmbeddingTokens: 1200,
      testInputTokens: 303_427, testOutputTokens: 17_389, testEmbeddingTokens: 3835,
    }
    const b = bucketAiCosts(u)
    const everything = usdForTokens(
      u.inputTokens + u.testInputTokens,
      u.outputTokens + u.testOutputTokens,
      u.embeddingTokens + u.buildEmbeddingTokens + u.testEmbeddingTokens,
    )
    expect(b.totalCostUsd).toBeCloseTo(everything, 10)
  })

  it('建置 token 同時寫在 input 與 import，客人那桶要把它扣掉', () => {
    const b = bucketAiCosts({ inputTokens: 100_000, importInputTokens: 40_000 })
    expect(b.conversation.inputTokens).toBe(60_000)
    expect(b.build.inputTokens).toBe(40_000)
  })

  it('後台自用只寫 test*，完全不進客人那桶', () => {
    const b = bucketAiCosts({ testInputTokens: 100_000, testOutputTokens: 5000 })
    expect(b.conversation.costUsd).toBe(0)
    expect(b.build.costUsd).toBe(0)
    expect(b.test.costUsd).toBeCloseTo(usdForTokens(100_000, 5000, 0), 10)
  })

  it('查詢向量進客人桶、建索引向量進建置桶，兩者不重疊', () => {
    const b = bucketAiCosts({ embeddingTokens: 9000, buildEmbeddingTokens: 1000 })
    expect(b.conversation.embeddingTokens).toBe(9000)
    expect(b.build.embeddingTokens).toBe(1000)
  })

  it('import 大於 input（記帳壞掉）時客人桶夾到 0，不會冒出負成本', () => {
    const b = bucketAiCosts({ inputTokens: 10, importInputTokens: 999 })
    expect(b.conversation.inputTokens).toBe(0)
    expect(b.conversation.costUsd).toBe(0)
  })

  it('空桶／undefined 一律回 0，不會是 NaN', () => {
    for (const u of [undefined, {}, { inputTokens: undefined }]) {
      const b = bucketAiCosts(u as never)
      expect(b.totalCostUsd).toBe(0)
      expect(Number.isNaN(b.conversation.costUsd)).toBe(false)
    }
  })

  it('牌價：每百萬 token 輸入 US$0.30、輸出 US$2.50、向量 US$0.15', () => {
    expect(usdForTokens(1_000_000, 0, 0)).toBeCloseTo(0.30, 10)
    expect(usdForTokens(0, 1_000_000, 0)).toBeCloseTo(2.50, 10)
    expect(usdForTokens(0, 0, 1_000_000)).toBeCloseTo(0.15, 10)
  })
})
