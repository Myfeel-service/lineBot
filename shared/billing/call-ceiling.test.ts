/**
 * AI 呼叫上限（`C-8`）的三支純函式：上限怎麼算、哪些次數算進去、什麼時候算撞到。
 */
import { describe, expect, it } from 'vitest'
import { AI_CALL_CEILING_MULTIPLIER, AI_CALL_CEILING_REMEDY, aiCallCeilingOf, aiCallsTowardCeiling, isAiCallCeilingHit } from './call-ceiling'
import { BILLING_PLANS } from './plans'

describe('aiCallCeilingOf — 上限＝則數額度 × 10', () => {
  it('倍數是 10（改了要一起改條款並升 POLICY_VERSION）', () => {
    expect(AI_CALL_CEILING_MULTIPLIER).toBe(10)
  })

  it('有則數上限的方案：額度 × 10', () => {
    expect(aiCallCeilingOf({ quota: BILLING_PLANS.free.answeredQuota, internal: false })).toBe(BILLING_PLANS.free.answeredQuota! * 10)
    expect(aiCallCeilingOf({ quota: 200, internal: false })).toBe(2_000)
  })

  it('內部／測試方案不套（就算被設了額度）', () => {
    expect(aiCallCeilingOf({ quota: null, internal: true })).toBeNull()
    expect(aiCallCeilingOf({ quota: 500, internal: true })).toBeNull()
  })

  it('不限則數（企業沒設額度）不套；額度 0 也不套（則數那條本來就先擋）', () => {
    expect(aiCallCeilingOf({ quota: null, internal: false })).toBeNull()
    expect(aiCallCeilingOf({ quota: 0, internal: false })).toBeNull()
  })
})

describe('aiCallsTowardCeiling — 只數 AI 真的被叫的', () => {
  it('扣掉指名找真人（AI 沒出手）與被額度擋下的（AI 沒出手）', () => {
    expect(aiCallsTowardCeiling({ invocations: 600, directHandoffs: 40, quotaBlocked: 60 })).toBe(500)
  })

  it('🔴 則數用完那段期間的訊息不算：不扣的話換期之後 AI 一恢復就以「呼叫太多」再停一次', () => {
    // 免費 50 則：月初就用完，之後 600 則訊息全被擋下（每則照樣記 invocations）
    const doc = { invocations: 50 + 600, quotaBlocked: 600 }
    expect(isAiCallCeilingHit(aiCallsTowardCeiling(doc), aiCallCeilingOf({ quota: 50, internal: false }))).toBe(false)
  })

  it('沒有文件／欄位＝0；不會變負數', () => {
    expect(aiCallsTowardCeiling(null)).toBe(0)
    expect(aiCallsTowardCeiling({})).toBe(0)
    expect(aiCallsTowardCeiling({ invocations: 3, directHandoffs: 5 })).toBe(0)
  })
})

describe('isAiCallCeilingHit — 到上限那一次就停', () => {
  it('9 倍不停、10 倍停', () => {
    const limit = aiCallCeilingOf({ quota: 50, internal: false })
    expect(isAiCallCeilingHit(450, limit)).toBe(false)
    expect(isAiCallCeilingHit(499, limit)).toBe(false)
    expect(isAiCallCeilingHit(500, limit)).toBe(true)
  })

  it('不套的帳號永遠不停', () => {
    expect(isAiCallCeilingHit(10_000_000, null)).toBe(false)
  })
})

describe('撞到之後給店家看的「怎麼辦」', () => {
  it('講補知識、講什麼時候恢復、講升級會提高上限（不講成「升級就好」）', () => {
    expect(AI_CALL_CEILING_REMEDY).toContain('補進知識庫')
    expect(AI_CALL_CEILING_REMEDY).toContain('下個月 1 號自動恢復')
    expect(AI_CALL_CEILING_REMEDY).toContain('提高上限')
  })
})
