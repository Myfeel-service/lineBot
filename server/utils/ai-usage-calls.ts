/**
 * AI 花費記帳的「這幾次呼叫 → 記進哪一桶、記多少」（`D-130`② 照模型分價／`C-338` 記帳不完整）。
 *
 * 單獨一個檔、只放純函式和計量器：很多測試會整個假掉 `gemini.ts` 或 `ai-usage.ts`（只留一兩支），
 * 這些東西放在那兩個檔裡的話，那些測試一碰到就會說「沒有這個 export」。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { modelKeyOf } from './ai-cost-buckets'
import type { UsageDelta } from './ai-usage'
import type { AiCostBucketId } from '~~/shared/types/ai-knowledge'

/**
 * **一次**付了錢的 AI 呼叫：用了哪顆模型、吃了多少 token。
 *
 * 記帳要照模型分價（flash-lite 比 flash 便宜 3～6 倍、生圖的輸出又貴 12 倍），
 * 所以每個回傳 token 數的地方都要一起帶上「這是哪顆模型算的」——包括
 * flash 塞車自動改用 flash-lite 的那一次（見 gemini.ts 的 generateParts），那次是照 lite 收錢的。
 */
export interface AiCallUsage {
  model: string
  inputTokens: number
  outputTokens: number
}

/** 一次呼叫的結果（帶 `model`），或幾次呼叫加總起來的結果（逐次的模型與 token 放在 `calls`） */
export interface AiCallsCarrier {
  inputTokens: number
  outputTokens: number
  /** 單次呼叫的結果才有：那次實際用的模型 */
  model?: string
  /** 加總型的結果才有（切卡分段、補問法分批…）：每一次呼叫各自的模型與 token */
  calls?: AiCallUsage[]
}

/**
 * 把「一次呼叫」或「加總起來的結果」攤回逐次呼叫，給記帳用。
 *
 * 舊的結果（或測試裡的假回傳）沒有模型資訊時，回一筆 `model: ''` 的呼叫——
 * token 照記、只是不知道是哪顆模型，記帳那邊會用大模型的價格估（寧可估高，不可漏記）。
 */
export function callsOf(r: AiCallsCarrier | null | undefined): AiCallUsage[] {
  if (!r) return []
  if (Array.isArray(r.calls)) return r.calls
  const inputTokens = Number(r.inputTokens ?? 0) || 0
  const outputTokens = Number(r.outputTokens ?? 0) || 0
  if (!inputTokens && !outputTokens) return []
  return [{ model: String(r.model ?? ''), inputTokens, outputTokens }]
}

/**
 * 呼叫成功、錢已經付了，但結果不能用（JSON 壞掉／被截斷、生圖只回了字）時丟的錯誤，
 * 身上帶著那次呼叫的用量——**付了錢就要記帳**（`C-338`②：以前這種情況整筆漏記）。
 * 抓到錯誤的地方用這支取出來記帳；不是這種錯誤（網路斷、額度擋下）回 `null`＝沒花錢。
 */
export function aiUsageOfError(err: unknown): AiCallUsage | null {
  const u = (err as { aiUsage?: AiCallUsage } | null | undefined)?.aiUsage
  if (!u || (!u.inputTokens && !u.outputTokens)) return null
  return u
}

// ── 計量器：「這一段付了哪幾次錢」 ─────────────────────────────────
//
// 一段流程裡叫了好幾次 AI、而且中途可能失敗（回答客人：判斷意圖 → 反問 → 答題 → 再讀一次），
// 每一步各自回傳 token 再一路加總，加總的那幾行遲早會漏一條（JSON 壞掉那次就是漏掉的）。
// 改成在**出口**記：gemini.ts 每次 Gemini 真的回了 200（＝要付錢），就把模型與 token 記到目前的計量器上，
// 流程最後把計量器倒出來入帳。跟額度守門（runWithLlmBudget）同一個收口的道理。
// ⛔ 計量器只收「這一段」：巢狀的話只記到最內層那個，外層看不到——各記各的，不會重複。
// ⛔ 一個計量器只給一個工作區、一個桶用：倒出來的東西會整包記進同一個地方。

const aiCallMeterALS = new AsyncLocalStorage<AiCallUsage[]>()

/** 在計量器底下跑一段：段內每一次付了錢的生成／生圖呼叫都會被記進 `meter`（含 JSON 壞掉、被截斷的那幾次） */
export function withAiCallMeter<T>(meter: AiCallUsage[], fn: () => Promise<T>): Promise<T> {
  return aiCallMeterALS.run(meter, fn)
}

/**
 * 在自己的計量器底下跑 `fn`，跑完——**成功或丟錯都一樣**——把這段付過錢的呼叫交給 `onSpent` 入帳。
 *
 * 給「叫 AI 的那一步會自己重試、或失敗就整個丟錯」的地方用（生成腳本：第一次沒過再生一次、兩次都沒過丟 422；
 * 以前丟錯時兩次的錢都沒記）。`onSpent` 出錯不會蓋掉 `fn` 原本的結果或錯誤。
 */
export async function runMeteredAi<T>(
  fn: () => Promise<T>,
  onSpent: (calls: AiCallUsage[]) => unknown,
): Promise<T> {
  const meter: AiCallUsage[] = []
  try {
    return await withAiCallMeter(meter, fn)
  }
  finally {
    if (meter.length) {
      try {
        await onSpent(meter.splice(0))
      }
      catch (e) {
        console.error('[ai-usage] 記帳失敗（不影響這次結果）：', e)
      }
    }
  }
}

/** 出口登記（只給 gemini.ts 用）：Gemini 回了 200 就記一筆；沒有計量器時什麼都不做 */
export function reportAiCall(u: AiCallUsage): void {
  if (!u.inputTokens && !u.outputTokens) return
  aiCallMeterALS.getStore()?.push({ model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens })
}

/**
 * 幾次 AI 生成呼叫 → 記到某一桶的用量（token 總數 ＋ 照模型分的明細）。
 *
 * **桶怎麼選**（看「哪一筆會隨客人變多而變多」，與成本頁說明卡同一套）：
 *   - `conversation` 回答客人：客人來一則訊息就會跑的（答題、判斷意圖、反問、讀照片、轉真人時的交接摘要）
 *   - `build` 整理知識庫：整理資料（切卡、OCR、同步、缺口掃描、讀網站認識你的店、AI 貼標掃描）
 *   - `test` 後台自用：後台有人按一下、等 AI 生東西給自己看（試打、小幫手、生成腳本、擬推播文案、
 *     選單底圖、貼標報告、每日摘要的節慶提醒）——要另外帶 `testInvocations`（成本進哪桶，次數就進哪桶）
 *
 * 記帳約定（三桶相加＝全部 token 的錢）由這支一次守住：建置同時寫總數與 import*、後台只寫 test*。
 * 呼叫的模型不認得（或沒帶模型）時，token 照記、不寫明細——算錢時照 flash 價估（寧可估高，不可漏記）。
 */
export function usageFromCalls(
  bucket: AiCostBucketId,
  calls: ReadonlyArray<AiCallUsage | null | undefined>,
): UsageDelta {
  let input = 0
  let output = 0
  const byModel: Record<string, { input: number; output: number }> = {}
  for (const c of calls) {
    if (!c) continue
    const i = Math.max(0, Number(c.inputTokens) || 0)
    const o = Math.max(0, Number(c.outputTokens) || 0)
    if (!i && !o) continue
    input += i
    output += o
    const key = modelKeyOf(c.model)
    if (!key) {
      // 不認得的模型：照記總數（算錢時當 flash），但講出來——單價表該加一列了
      if (c.model) console.warn('[ai-usage] 單價表沒有這顆模型，先照 flash 價估：', c.model)
      continue
    }
    const slot = byModel[key] ?? (byModel[key] = { input: 0, output: 0 })
    slot.input += i
    slot.output += o
  }
  if (!input && !output) return {}
  const delta: UsageDelta = bucket === 'test'
    ? { testInputTokens: input, testOutputTokens: output }
    : bucket === 'build'
      ? { inputTokens: input, outputTokens: output, importInputTokens: input, importOutputTokens: output }
      : { inputTokens: input, outputTokens: output }
  if (Object.keys(byModel).length) delta.modelTokens = { [bucket]: byModel }
  return delta
}

/** 每月上限擋下來的錯誤上帶的記號（`error.data.reason`，`C-413`）：判斷「是不是上限擋的」看這個，⛔ 不要比對訊息文字 */
export const AI_BUDGET_ERROR_REASON = 'ai_budget'

/**
 * 這個錯誤是不是每月上限（`assertMaintenanceBudget`）擋下來的。新的錯誤看 `data.reason`；
 * 舊格式（`C-413` 以前的訊息、或測試裡手做的錯誤）退回比對文字。
 * ⚠️ 放這個檔不放 ai-usage.ts：很多測試把 ai-usage.ts 整個假掉，放那裡會「沒有這個 export」。
 */
export function isAiBudgetError(err: unknown): boolean {
  const e = err as { statusCode?: unknown; data?: { reason?: unknown }; statusMessage?: unknown; message?: unknown } | null | undefined
  if (Number(e?.statusCode) !== 429) return false
  if (e?.data?.reason === AI_BUDGET_ERROR_REASON) return true
  return /AI 整理用量|到上限了/.test(String(e?.statusMessage ?? e?.message ?? ''))
}

/**
 * 背景工作（AI 貼標建議、標籤發現、知識缺口掃描——客人聊越多用越多、不是店家加資料）的用量（`C-413`）：
 * 照記進整理知識庫那桶（算錢不變），另外把同一筆的整理桶數字標成 `backgroundTokens`，
 * 每月上限才分得出「店家加資料」跟「背景工作」兩本帳。
 * ⛔ 只包 `usageFromCalls('build', …)` 出來的東西；包別桶的不會多出任何數字。
 */
export function asBackgroundUsage(delta: UsageDelta): UsageDelta {
  const t = (Number(delta.importInputTokens ?? 0) || 0)
    + (Number(delta.importOutputTokens ?? 0) || 0)
    + (Number(delta.buildEmbeddingTokens ?? 0) || 0)
  return t > 0 ? { ...delta, backgroundTokens: (Number(delta.backgroundTokens ?? 0) || 0) + t } : delta
}

/** 把幾筆用量加成一筆（數字相加、模型明細逐桶逐模型相加），給「一次記帳」用 */
export function mergeUsage(...deltas: Array<UsageDelta | null | undefined>): UsageDelta {
  const out: Record<string, unknown> = {}
  for (const d of deltas) {
    if (!d) continue
    for (const [k, v] of Object.entries(d)) {
      if (k === 'modelTokens') continue
      if (typeof v === 'number' && v) out[k] = (Number(out[k] ?? 0) || 0) + v
    }
    if (d.modelTokens) {
      const mt = (out.modelTokens ?? (out.modelTokens = {})) as Record<string, Record<string, { input: number; output: number }>>
      for (const [bucket, byModel] of Object.entries(d.modelTokens)) {
        for (const [key, t] of Object.entries(byModel ?? {})) {
          const slot = ((mt[bucket] ??= {})[key] ??= { input: 0, output: 0 })
          slot.input += Number(t?.input ?? 0) || 0
          slot.output += Number(t?.output ?? 0) || 0
        }
      }
    }
  }
  return out as UsageDelta
}
