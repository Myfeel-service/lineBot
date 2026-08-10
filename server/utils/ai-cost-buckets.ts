import type { AiUsageDoc } from '~~/shared/types/ai-knowledge'

/**
 * AI（Gemini）月結桶 → 依「用途」拆三桶的成本／token。
 *
 * 超管成本頁與各工作區用量頁**共用這一份**：兩邊本來各自寫一次同樣的算式，
 * 任何一邊改價或改口徑就會悄悄對不起來。改價只改這裡。
 *
 * 用量 doc 未分模型（router／反問走 flash-lite、答題走 flash 混計），
 * 一律以較貴的 flash 費率估 → 估算值偏保守（上限），實際以 Google 帳單為準。
 *
 * ⛔ **記帳約定（改記帳程式前先看這段）**：
 *   - 建置（匯入／整理知識庫）的 token 要**同時**寫進 `inputTokens` 與 `importInputTokens`
 *     ——「客人對話」是用相減得出來的，只寫其中一邊就會算錯。
 *   - 後台自用（playground 試打、小幫手）只寫 `test*`，**不要**寫進 `inputTokens`，
 *     否則會被算進客人成本，讓每則客人單價虛高。
 *   - 建索引的向量寫 `buildEmbeddingTokens`，客人查詢的向量寫 `embeddingTokens`，兩者不重疊。
 *   守住這三條，三桶相加就會剛好等於全部 token 的錢（有測試在守，見 ai-cost-buckets.test.ts）。
 */

export const GEMINI_PRICING = {
  inputPerM: 0.30,
  outputPerM: 2.50,
  embedPerM: 0.15,
} as const

export const USD_TO_TWD = 32

export function usdForTokens(input: number, output: number, embed: number): number {
  return (input / 1_000_000) * GEMINI_PRICING.inputPerM
    + (output / 1_000_000) * GEMINI_PRICING.outputPerM
    + (embed / 1_000_000) * GEMINI_PRICING.embedPerM
}

export type BucketBreakdown = {
  inputTokens: number
  outputTokens: number
  embeddingTokens: number
  /** 三種 token 相加，給「用了多少字」用 */
  tokens: number
  costUsd: number
}

export type AiCostBuckets = {
  /** 跟真客人來回問答（頭條成本就是這桶） */
  conversation: BucketBreakdown
  /** 匯入、切卡、建索引——一次性／偶爾的花費 */
  build: BucketBreakdown
  /** 後台自用：playground 試打 ＋ 後台小幫手 */
  test: BucketBreakdown
  totalCostUsd: number
}

const num = (v: unknown) => Number(v ?? 0) || 0

function breakdown(input: number, output: number, embed: number): BucketBreakdown {
  return {
    inputTokens: input,
    outputTokens: output,
    embeddingTokens: embed,
    tokens: input + output + embed,
    costUsd: usdForTokens(input, output, embed),
  }
}

/** 把一顆月結桶拆成三桶。三桶相加＝這顆桶所有 token 的錢，不多不少。 */
export function bucketAiCosts(u: Partial<AiUsageDoc> | undefined): AiCostBuckets {
  const inputTokens = num(u?.inputTokens)
  const outputTokens = num(u?.outputTokens)
  const embeddingTokens = num(u?.embeddingTokens)
  const importInputTokens = num(u?.importInputTokens)
  const importOutputTokens = num(u?.importOutputTokens)
  const buildEmbeddingTokens = num(u?.buildEmbeddingTokens)

  // 匯入 input/output 是 input/output 的子集（記帳時兩邊都寫），故客人對話要把它減掉。
  // clamp 到 0 是防禦性的：真的出現負數代表記帳壞了，寧可少算也不要冒出負成本。
  const conversation = breakdown(
    Math.max(0, inputTokens - importInputTokens),
    Math.max(0, outputTokens - importOutputTokens),
    embeddingTokens,
  )
  const build = breakdown(importInputTokens, importOutputTokens, buildEmbeddingTokens)
  const test = breakdown(num(u?.testInputTokens), num(u?.testOutputTokens), num(u?.testEmbeddingTokens))

  return {
    conversation,
    build,
    test,
    totalCostUsd: conversation.costUsd + build.costUsd + test.costUsd,
  }
}
