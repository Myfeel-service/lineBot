import type { AiModelTokenCounts, AiUsageDoc } from '~~/shared/types/ai-knowledge'

/**
 * AI（Gemini）月結桶 → 依「用途」拆三桶的成本／token。
 *
 * 超管成本頁、超管帳號列表、各工作區用量頁**共用這一份**：以前各自寫一次同樣的算式，
 * 任何一邊改價或改口徑就會悄悄對不起來。**改價只改這裡。**
 *
 * ── 照實際模型算（`D-130`②，2026-10-19 老闆「要」）──────────────────────────
 * 以前月結桶只有 token 總數、不知道是哪顆模型算的，一律用最貴的 flash 價估，
 * 「回答客人」那桶因此估高約 25～35%（判斷意圖、反問、讀摘要都是便宜 3～6 倍的 flash-lite）。
 * 現在每次記帳都另外寫一份「哪顆模型用了多少」（`modelTokens`，是總數的**子集**，
 * 同 importInputTokens ⊆ inputTokens 的慣例），算錢時：
 *   有模型明細的那部分 → 照那顆模型的單價
 *   總數減掉明細剩下的 → 照 flash 價（＝上線前的舊資料，以及不知道模型的少數呼叫；寧可估高）
 * ⛔ 舊資料不回填：月結桶是加總值，拆不出哪幾個 token 是哪顆模型的（同 `F-1`）。
 *
 * ⛔ **記帳約定（改記帳程式前先看這段）**：
 *   - 建置（匯入／整理知識庫）的 token 要**同時**寫進 `inputTokens` 與 `importInputTokens`
 *     ——「客人對話」是用相減得出來的，只寫其中一邊就會算錯。
 *   - 後台自用（playground 試打、小幫手）只寫 `test*`，**不要**寫進 `inputTokens`，
 *     否則會被算進客人成本，讓每則客人單價虛高。
 *   - 建索引的向量寫 `buildEmbeddingTokens`，客人查詢的向量寫 `embeddingTokens`，兩者不重疊。
 *   - 模型明細一律經 `ai-usage.ts` 的 `usageFromCalls` 產生，它會把總數與明細寫在同一桶，不會只寫一邊。
 *   守住這幾條，三桶相加就會剛好等於全部 token 的錢（有測試在守，見 ai-cost-buckets.test.ts）。
 */

/**
 * Gemini 牌價（USD／每百萬 token，付費層 Standard）。
 *
 * 來源（2026-10-19 查）：
 *   - 定價頁 https://ai.google.dev/gemini-api/docs/pricing（頁面標「Last updated 2026-10-16 UTC」）
 *       gemini-2.5-flash        輸入 $0.30／輸出 $2.50（輸出含思考 token）
 *       gemini-2.5-flash-lite   輸入 $0.10／輸出 $0.40
 *       gemini-2.5-flash-image  輸入 $0.30／輸出（圖）$30——一張 1024×1024 吃 1,290 token＝US$0.039
 *   - 向量 gemini-embedding-001：$0.15。⚠️ 10-16 版定價頁已經不列這顆（只列 embedding-2 $0.20），
 *     沿用 2026-07 查證的值；同一頁 File search 段落仍寫「embeddings $0.15」。
 *   - 下線日 https://ai.google.dev/gemini-api/docs/deprecations（10-12 版）：flash／flash-lite 未公布、
 *     flash-image 2027-03-15（⚠️ 定價頁寫 2026-10-02，兩頁不一致，見 `C-338`④）、embedding-001 2028-05-14。
 *
 * key 是寫進 Firestore 的欄位名（`modelTokens.<桶>.<key>`），⛔ 不要改名：改了舊月份的明細就對不上。
 * 新增模型就加一列；沒列在這裡的模型照 flash 價估（`modelKeyOf` 回 null）。
 */
export const GEMINI_MODEL_PRICES = {
  flash: { model: 'gemini-2.5-flash', inputPerM: 0.30, outputPerM: 2.50 },
  flashLite: { model: 'gemini-2.5-flash-lite', inputPerM: 0.10, outputPerM: 0.40 },
  flashImage: { model: 'gemini-2.5-flash-image', inputPerM: 0.30, outputPerM: 30 },
} as const

export type GeminiModelKey = keyof typeof GEMINI_MODEL_PRICES

/** 向量（gemini-embedding-001）每百萬 token。只有這一顆，不必分模型。 */
export const EMBEDDING_PRICE_PER_M = 0.15

/** 不知道是哪顆模型時用的價格＝最常用、也比較貴的 flash（寧可估高） */
const UNSPLIT_PRICE = GEMINI_MODEL_PRICES.flash

/**
 * 舊介面：「全部當 flash 算」的那組價格。API 還把它回給前端（畫面目前沒用到），保留形狀。
 * ⛔ 新程式算錢請用 bucketAiCosts，不要拿這組價格自己乘。
 */
export const GEMINI_PRICING = {
  inputPerM: UNSPLIT_PRICE.inputPerM,
  outputPerM: UNSPLIT_PRICE.outputPerM,
  embedPerM: EMBEDDING_PRICE_PER_M,
} as const

/** 匯率的單一來源在 `shared/usd-twd.ts`；這裡只是轉出去給舊的匯入點用 */
export { USD_TO_TWD } from '~~/shared/usd-twd'

const MODEL_KEY_BY_ID = new Map<string, GeminiModelKey>(
  (Object.keys(GEMINI_MODEL_PRICES) as GeminiModelKey[]).map(k => [GEMINI_MODEL_PRICES[k].model, k]),
)

/** 模型 id（`gemini-2.5-flash-lite`）→ 記帳用的 key（`flashLite`）；不認得回 null（照 flash 價估） */
export function modelKeyOf(model: string | null | undefined): GeminiModelKey | null {
  const id = String(model ?? '').trim().replace(/^models\//, '')
  return MODEL_KEY_BY_ID.get(id) ?? null
}

/** 不分模型、一律用 flash 價（舊資料、不知道模型的那部分用這個） */
export function usdForTokens(input: number, output: number, embed: number): number {
  return (input / 1_000_000) * UNSPLIT_PRICE.inputPerM
    + (output / 1_000_000) * UNSPLIT_PRICE.outputPerM
    + (embed / 1_000_000) * EMBEDDING_PRICE_PER_M
}

/** 某一顆模型用了這麼多 token 要多少錢 */
export function usdForModelTokens(key: GeminiModelKey, input: number, output: number): number {
  const p = GEMINI_MODEL_PRICES[key]
  return (input / 1_000_000) * p.inputPerM + (output / 1_000_000) * p.outputPerM
}

/** 一桶裡「哪顆模型用了多少」（Firestore 的 `modelTokens.<桶>`） */
export type ModelTokenCounts = AiModelTokenCounts

export type BucketBreakdown = {
  inputTokens: number
  outputTokens: number
  embeddingTokens: number
  /** 三種 token 相加，給「用了多少字」用 */
  tokens: number
  costUsd: number
  /**
   * 生成（不含向量）的 token 裡，有幾個**不知道是哪顆模型**、只好用 flash 價估的。
   * 照模型分價上線前的舊資料全落在這裡；上線後應該接近 0。畫面靠它決定要不要講「這段是用大模型價格估的」。
   */
  unsplitTokens: number
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

function breakdown(input: number, output: number, embed: number, byModel: ModelTokenCounts | undefined): BucketBreakdown {
  let splitIn = 0
  let splitOut = 0
  let splitUsd = 0
  for (const key of Object.keys(GEMINI_MODEL_PRICES) as GeminiModelKey[]) {
    const i = Math.max(0, num(byModel?.[key]?.input))
    const o = Math.max(0, num(byModel?.[key]?.output))
    if (!i && !o) continue
    splitIn += i
    splitOut += o
    splitUsd += usdForModelTokens(key, i, o)
  }
  // 總數減掉有明細的＝不知道模型的那部分，照 flash 價。
  // 明細大於總數（記帳壞掉）時夾到 0，並把顯示的 token 數拉到明細那麼多——錢跟字數要對得起來。
  const restIn = Math.max(0, input - splitIn)
  const restOut = Math.max(0, output - splitOut)
  const shownIn = Math.max(input, splitIn)
  const shownOut = Math.max(output, splitOut)
  return {
    inputTokens: shownIn,
    outputTokens: shownOut,
    embeddingTokens: embed,
    tokens: shownIn + shownOut + embed,
    costUsd: splitUsd + usdForTokens(restIn, restOut, embed),
    unsplitTokens: restIn + restOut,
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
  const byModel = u?.modelTokens

  // 匯入 input/output 是 input/output 的子集（記帳時兩邊都寫），故客人對話要把它減掉。
  // clamp 到 0 是防禦性的：真的出現負數代表記帳壞了，寧可少算也不要冒出負成本。
  const conversation = breakdown(
    Math.max(0, inputTokens - importInputTokens),
    Math.max(0, outputTokens - importOutputTokens),
    embeddingTokens,
    byModel?.conversation,
  )
  const build = breakdown(importInputTokens, importOutputTokens, buildEmbeddingTokens, byModel?.build)
  const test = breakdown(num(u?.testInputTokens), num(u?.testOutputTokens), num(u?.testEmbeddingTokens), byModel?.test)

  return {
    conversation,
    build,
    test,
    totalCostUsd: conversation.costUsd + build.costUsd + test.costUsd,
  }
}
