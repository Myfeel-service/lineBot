import { describe, expect, it } from 'vitest'
import { budgetPauseActive, isAiBudgetErrorLike } from './ai-budget'

/**
 * `C-414`：「這個月先停」只存月份、話在讀的當下才組。
 * 以前存整句（「…11 月 1 日恢復」），排程之後不再碰那一份（關掉自動同步、刪掉那一頁），12 月還掛著。
 */
describe('budgetPauseActive：只認這個月停的', () => {
  const oct = new Date('2026-10-29T12:00:00+08:00')

  it('這個月停的算；上個月停的不算（過了月自然失效，不用誰回頭清）', () => {
    expect(budgetPauseActive('202610', oct)).toBe(true)
    expect(budgetPauseActive('202609', oct)).toBe(false)
    expect(budgetPauseActive('202610', new Date('2026-11-01T00:05:00+08:00'))).toBe(false)
  })

  it('月份照台灣時間：UTC 還在 10 月、台灣已經 11 月 1 日 → 10 月停的不算了', () => {
    expect(budgetPauseActive('202610', new Date('2026-10-31T17:00:00Z'))).toBe(false)
  })

  it('沒有標記、格式不對都不算', () => {
    expect(budgetPauseActive(undefined, oct)).toBe(false)
    expect(budgetPauseActive('', oct)).toBe(false)
    expect(budgetPauseActive(202610, oct)).toBe(false)
  })
})

describe('isAiBudgetErrorLike：瀏覽器端認「每月上限」', () => {
  it('HTTP 錯誤看回應裡的記號（h3 把 createError 的 data 包在 data.data）', () => {
    expect(isAiBudgetErrorLike({ statusCode: 429, data: { statusMessage: '…', data: { reason: 'ai_budget', kind: 'knowledge' } } })).toBe(true)
  })

  it('只拿得到一句話的（輪詢工作）比對那半句', () => {
    expect(isAiBudgetErrorLike(new Error('這個月加入資料到上限了，11 月 1 日恢復。這段期間…'))).toBe(true)
  })

  it('⛔ Gemini 一時過載的 429、其他錯不算', () => {
    expect(isAiBudgetErrorLike({ statusCode: 429, data: { statusMessage: '太頻繁了，請稍後再試' } })).toBe(false)
    expect(isAiBudgetErrorLike({ statusCode: 403, data: { statusMessage: 'AI 知識量滿了' } })).toBe(false)
    expect(isAiBudgetErrorLike(null)).toBe(false)
  })
})
