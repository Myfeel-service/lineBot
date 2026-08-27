import { describe, it, expect } from 'vitest'
import { evaluateUsageRatio } from './usage-ratio'

describe('evaluateUsageRatio（C-7 呼叫/答出高成本警示）', () => {
  it('正常帳號（比值約 2.5）不標', () => {
    const v = evaluateUsageRatio(100, 40)
    expect(v.ratio).toBe(2.5)
    expect(v.flagged).toBe(false)
  })

  it('比值超過 5 倍才標；剛好 5 倍不標（門檻是「超過」）', () => {
    expect(evaluateUsageRatio(300, 50).flagged).toBe(true) // 6 倍
    expect(evaluateUsageRatio(250, 50).flagged).toBe(false) // 恰 5 倍
  })

  it('低量護欄：本月呼叫不足 30 次一律不判（小樣本比值全是噪音）', () => {
    expect(evaluateUsageRatio(29, 0).flagged).toBe(false)
    expect(evaluateUsageRatio(20, 1).flagged).toBe(false) // 比值 20 也不標
  })

  it('answered=0 且呼叫夠多＝最極端，要標；比值回 null 不回 Infinity', () => {
    const v = evaluateUsageRatio(30, 0)
    expect(v.flagged).toBe(true)
    expect(v.ratio).toBeNull()
  })

  it('髒輸入（負數、NaN）收斂成 0，不炸也不誤標', () => {
    const v = evaluateUsageRatio(Number.NaN, -5)
    expect(v).toMatchObject({ invocations: 0, answered: 0, ratio: null, flagged: false })
  })
})
