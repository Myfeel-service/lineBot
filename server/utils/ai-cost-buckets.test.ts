import { describe, expect, it } from 'vitest'
import { bucketAiCosts, GEMINI_MODEL_PRICES, modelKeyOf, usdForModelTokens, usdForTokens } from './ai-cost-buckets'

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

/**
 * `D-130`②：照實際模型分價。明細（modelTokens）是總數的子集，有明細的照那顆模型算、剩下的照 flash 估。
 */
describe('bucketAiCosts — 照實際模型算', () => {
  it('單價表照 Google 定價頁（2026-10-16 版）：lite 0.10/0.40、生圖輸出 30', () => {
    expect(GEMINI_MODEL_PRICES.flash).toMatchObject({ model: 'gemini-2.5-flash', inputPerM: 0.30, outputPerM: 2.50 })
    expect(GEMINI_MODEL_PRICES.flashLite).toMatchObject({ model: 'gemini-2.5-flash-lite', inputPerM: 0.10, outputPerM: 0.40 })
    expect(GEMINI_MODEL_PRICES.flashImage).toMatchObject({ model: 'gemini-2.5-flash-image', inputPerM: 0.30, outputPerM: 30 })
    expect(modelKeyOf('gemini-2.5-flash-lite')).toBe('flashLite')
    expect(modelKeyOf('models/gemini-2.5-flash')).toBe('flash')
    expect(modelKeyOf('gemini-9-ultra')).toBeNull()
    expect(modelKeyOf('')).toBeNull()
  })

  it('判意圖這種 flash-lite 的呼叫照 lite 價，不再用大模型價（便宜 3～6 倍）', () => {
    const b = bucketAiCosts({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      modelTokens: { conversation: { flashLite: { input: 1_000_000, output: 1_000_000 } } },
    })
    expect(b.conversation.costUsd).toBeCloseTo(0.10 + 0.40, 10)
    expect(b.conversation.unsplitTokens).toBe(0)
  })

  it('有明細的照模型、沒明細的剩餘照 flash（上線那個月新舊混在一起）', () => {
    const b = bucketAiCosts({
      inputTokens: 3_000_000, // 其中 1M 是 lite（新記的），2M 不知道模型（舊資料）
      outputTokens: 0,
      modelTokens: { conversation: { flashLite: { input: 1_000_000 } } },
    })
    expect(b.conversation.costUsd).toBeCloseTo(1 * 0.10 + 2 * 0.30, 10)
    expect(b.conversation.unsplitTokens).toBe(2_000_000)
  })

  it('沒有明細的舊月份：跟以前一模一樣（全部照 flash），而且全部算成「用大模型價格估」', () => {
    const u = { inputTokens: 504_127, outputTokens: 65_770, embeddingTokens: 9125 }
    const b = bucketAiCosts(u)
    expect(b.conversation.costUsd).toBeCloseTo(usdForTokens(504_127, 65_770, 9125), 10)
    expect(b.conversation.unsplitTokens).toBe(504_127 + 65_770)
  })

  it('生圖：一張 1,290 個輸出 token＝約 US$0.039（以前當文字價記成 US$0.003，少 12 倍）', () => {
    const b = bucketAiCosts({
      testInputTokens: 0,
      testOutputTokens: 1290,
      modelTokens: { test: { flashImage: { output: 1290 } } },
    })
    expect(b.test.costUsd).toBeCloseTo(0.0387, 6)
    expect(usdForTokens(0, 1290, 0)).toBeCloseTo(0.003225, 6) // 舊算法，對照用
  })

  it('建置、後台各自的明細只算進自己那桶；三桶相加＝各模型各自的錢', () => {
    const b = bucketAiCosts({
      inputTokens: 300, outputTokens: 30, importInputTokens: 200, importOutputTokens: 20,
      testInputTokens: 50, testOutputTokens: 5,
      modelTokens: {
        conversation: { flashLite: { input: 100, output: 10 } },
        build: { flash: { input: 200, output: 20 } },
        test: { flashLite: { input: 50, output: 5 } },
      },
    })
    expect(b.conversation.costUsd).toBeCloseTo(usdForModelTokens('flashLite', 100, 10), 12)
    expect(b.build.costUsd).toBeCloseTo(usdForModelTokens('flash', 200, 20), 12)
    expect(b.test.costUsd).toBeCloseTo(usdForModelTokens('flashLite', 50, 5), 12)
    expect(b.totalCostUsd).toBeCloseTo(
      usdForModelTokens('flashLite', 150, 15) + usdForModelTokens('flash', 200, 20), 12)
  })

  it('明細比總數還多（記帳壞了）：錢照明細算、不出現負數，字數也跟著拉到明細那麼多', () => {
    const b = bucketAiCosts({ inputTokens: 10, modelTokens: { conversation: { flash: { input: 100 } } } })
    expect(b.conversation.costUsd).toBeCloseTo(usdForModelTokens('flash', 100, 0), 12)
    expect(b.conversation.inputTokens).toBe(100)
    expect(b.conversation.unsplitTokens).toBe(0)
  })
})
