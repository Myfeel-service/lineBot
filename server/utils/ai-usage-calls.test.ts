/**
 * 「這幾次 AI 呼叫 → 記進哪一桶、記多少」（`D-130`② 照模型分價／`C-338` 記帳不完整）。
 *
 * 守的是記帳約定（改錯了畫面上只會是一個看起來很合理的數字）：
 *   - 三個桶各自寫對的欄位（建置同時寫總數與 import*、後台只寫 test*）
 *   - 模型明細跟總數寫在同一桶、數字一致；不認得的模型照記總數、不寫明細（照 flash 估）
 *   - 計量器：段內每一次付了錢的呼叫都記到，丟錯也照記
 */
import { describe, expect, it, vi } from 'vitest'
import {
  aiUsageOfError,
  callsOf,
  mergeUsage,
  reportAiCall,
  runMeteredAi,
  usageFromCalls,
  withAiCallMeter,
  type AiCallUsage,
} from './ai-usage-calls'

const lite = (i: number, o: number): AiCallUsage => ({ model: 'gemini-2.5-flash-lite', inputTokens: i, outputTokens: o })
const flash = (i: number, o: number): AiCallUsage => ({ model: 'gemini-2.5-flash', inputTokens: i, outputTokens: o })

describe('usageFromCalls：桶與欄位', () => {
  it('回答客人：只寫 inputTokens/outputTokens，明細記在 conversation', () => {
    expect(usageFromCalls('conversation', [lite(10, 2), flash(100, 20)])).toEqual({
      inputTokens: 110,
      outputTokens: 22,
      modelTokens: { conversation: { flashLite: { input: 10, output: 2 }, flash: { input: 100, output: 20 } } },
    })
  })

  it('整理知識庫：總數與 import* 都要寫（客人那桶是相減出來的）', () => {
    expect(usageFromCalls('build', [flash(100, 20)])).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      importInputTokens: 100,
      importOutputTokens: 20,
      modelTokens: { build: { flash: { input: 100, output: 20 } } },
    })
  })

  it('後台自用：只寫 test*，⛔ 不碰客人那桶的總數', () => {
    const d = usageFromCalls('test', [{ model: 'gemini-2.5-flash-image', inputTokens: 30, outputTokens: 1290 }])
    expect(d).toEqual({
      testInputTokens: 30,
      testOutputTokens: 1290,
      modelTokens: { test: { flashImage: { input: 30, output: 1290 } } },
    })
    expect(d.inputTokens).toBeUndefined()
  })

  it('不認得的模型（或沒帶模型的舊結果）：總數照記、不寫明細＝照 flash 估，寧可估高不可漏記', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(usageFromCalls('conversation', [{ model: 'gemini-9-ultra', inputTokens: 5, outputTokens: 1 }, { model: '', inputTokens: 3, outputTokens: 1 }]))
      .toEqual({ inputTokens: 8, outputTokens: 2 })
    expect(warn).toHaveBeenCalledTimes(1) // 只有「有寫模型但單價表沒有」那筆要喊；沒帶模型的不喊
    warn.mockRestore()
  })

  it('沒有呼叫／null／0 token：回空物件（記帳端就不會白寫一次）', () => {
    expect(usageFromCalls('build', [])).toEqual({})
    expect(usageFromCalls('build', [null, undefined, flash(0, 0)])).toEqual({})
  })
})

describe('mergeUsage', () => {
  it('數字相加、明細逐桶逐模型相加；0 不留', () => {
    const merged = mergeUsage(
      { invocations: 1, handoffs: 1, embeddingTokens: 5 },
      usageFromCalls('conversation', [lite(10, 2)]),
      usageFromCalls('conversation', [lite(1, 1), flash(100, 0)]),
      { answered: 0 },
    )
    expect(merged).toEqual({
      invocations: 1,
      handoffs: 1,
      embeddingTokens: 5,
      inputTokens: 111,
      outputTokens: 3,
      modelTokens: { conversation: { flashLite: { input: 11, output: 3 }, flash: { input: 100, output: 0 } } },
    })
  })
})

describe('callsOf／aiUsageOfError', () => {
  it('單次結果帶 model → 一筆；加總結果帶 calls → 照 calls；舊結果沒模型 → 一筆 model 空字串', () => {
    expect(callsOf({ inputTokens: 5, outputTokens: 1, model: 'gemini-2.5-flash-lite' })).toEqual([lite(5, 1)])
    expect(callsOf({ inputTokens: 999, outputTokens: 999, calls: [lite(1, 1), flash(2, 2)] })).toEqual([lite(1, 1), flash(2, 2)])
    expect(callsOf({ inputTokens: 5, outputTokens: 1 })).toEqual([{ model: '', inputTokens: 5, outputTokens: 1 }])
    expect(callsOf({ inputTokens: 0, outputTokens: 0 })).toEqual([])
    expect(callsOf(null)).toEqual([])
  })

  it('錯誤身上帶著用量才算「付了錢」；網路錯誤、額度擋下沒有用量＝null', () => {
    expect(aiUsageOfError(Object.assign(new Error('JSON parse failed'), { aiUsage: flash(10, 5) }))).toEqual(flash(10, 5))
    expect(aiUsageOfError(new Error('network'))).toBeNull()
    expect(aiUsageOfError(Object.assign(new Error('x'), { aiUsage: flash(0, 0) }))).toBeNull()
    expect(aiUsageOfError(undefined)).toBeNull()
  })
})

describe('計量器', () => {
  it('段內每一次出口登記都收到；段外的不收；巢狀只記最內層', async () => {
    const outer: AiCallUsage[] = []
    const inner: AiCallUsage[] = []
    reportAiCall(flash(1, 1)) // 沒有計量器：什麼都不做
    await withAiCallMeter(outer, async () => {
      reportAiCall(lite(5, 1))
      await withAiCallMeter(inner, async () => {
        await Promise.resolve()
        reportAiCall(flash(100, 10))
      })
      await new Promise(r => setTimeout(r, 1))
      reportAiCall(lite(2, 2))
    })
    expect(outer).toEqual([lite(5, 1), lite(2, 2)])
    expect(inner).toEqual([flash(100, 10)])
  })

  it('兩段同時跑不會互相混帳（客人 A 與 B 同時來訊）', async () => {
    const a: AiCallUsage[] = []
    const b: AiCallUsage[] = []
    await Promise.all([
      withAiCallMeter(a, async () => { await new Promise(r => setTimeout(r, 5)); reportAiCall(lite(1, 1)) }),
      withAiCallMeter(b, async () => { reportAiCall(flash(9, 9)); await new Promise(r => setTimeout(r, 1)) }),
    ])
    expect(a).toEqual([lite(1, 1)])
    expect(b).toEqual([flash(9, 9)])
  })

  it('runMeteredAi：成功照記；⛔ 丟錯也照記（付了錢的那幾次）而且原本的錯誤照樣丟出去', async () => {
    const spent: AiCallUsage[][] = []
    const ok = await runMeteredAi(async () => { reportAiCall(flash(10, 2)); return 'ok' }, c => spent.push(c))
    expect(ok).toBe('ok')
    await expect(runMeteredAi(async () => {
      reportAiCall(flash(20, 3)) // 第一次生成沒過
      reportAiCall(flash(21, 4)) // 重生一次也沒過 → 丟 422
      throw Object.assign(new Error('AI 這次沒生好'), { statusCode: 422 })
    }, c => spent.push(c))).rejects.toMatchObject({ statusCode: 422 })
    expect(spent).toEqual([[flash(10, 2)], [flash(20, 3), flash(21, 4)]])
  })

  it('runMeteredAi：一次都沒叫到 AI 就不記；記帳本身出錯不會蓋掉結果', async () => {
    const onSpent = vi.fn()
    await runMeteredAi(async () => 1, onSpent)
    expect(onSpent).not.toHaveBeenCalled()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(runMeteredAi(async () => { reportAiCall(flash(1, 1)); return 7 }, () => { throw new Error('db down') })).resolves.toBe(7)
    err.mockRestore()
  })
})
