/**
 * 後台額度橫幅（與方案頁那格）的說法：兩種「AI 停了」要分得出原因（`C-8`），後果那句一字不差（`C-341`）。
 */
import { describe, expect, it } from 'vitest'
import { QUOTA_STOPPED_CONSEQUENCE, aiCallPausedText, isPausedByCalls, quotaBannerDesc } from './quota-banner-text'

describe('isPausedByCalls — 什麼時候講「被叫太多次」', () => {
  it('撞到上限、則數還沒用完 → 講被叫太多次', () => {
    expect(isPausedByCalls({ hit: true }, 'ok')).toBe(true)
    expect(isPausedByCalls({ hit: true }, 'near')).toBe(true)
  })

  it('則數也用完 → 講則數用完（跟後端判斷的先後一樣）', () => {
    expect(isPausedByCalls({ hit: true }, 'over')).toBe(false)
  })

  it('沒撞到、不套、讀不到 → 不講', () => {
    expect(isPausedByCalls({ hit: false }, 'ok')).toBe(false)
    expect(isPausedByCalls(null, 'ok')).toBe(false)
  })
})

describe('quotaBannerDesc', () => {
  it('則數用完：講用了幾則、升級就恢復', () => {
    const t = quotaBannerDesc({ state: 'over', used: 50, limit: 50, pausedByCalls: false })
    expect(t).toBe(`本期 50 則已用完。${QUOTA_STOPPED_CONSEQUENCE}升級後立即恢復。`)
    expect(t).not.toContain('被叫')
  })

  it('🔴 AI 被叫太多次而停（則數還沒用完）：講原因與補知識，⛔ 不講「則已用完」', () => {
    const t = quotaBannerDesc({ state: 'ok', used: 12, limit: 50, pausedByCalls: true, calls: 1234 })
    expect(t).toContain('這個月 AI 被叫了 1,234 次、大多答不出來，先停下來了。')
    expect(t).toContain(QUOTA_STOPPED_CONSEQUENCE)
    expect(t).toContain('補進知識庫')
    expect(t).toContain('下個月 1 號自動恢復')
    expect(t).not.toContain('已用完')
    expect(t).not.toContain('12 / 50')
  })

  it('兩種停了的後果那句一字不差（C-341：自動回應照常、需要 AI 回答的才轉真人）', () => {
    expect(QUOTA_STOPPED_CONSEQUENCE).toBe('自動回應仍正常運作，但需要 AI 回答的問題現在都會轉給真人客服。')
    expect(quotaBannerDesc({ state: 'over', used: 50, limit: 50, pausedByCalls: false })).toContain(QUOTA_STOPPED_CONSEQUENCE)
    expect(aiCallPausedText(600)).toContain(QUOTA_STOPPED_CONSEQUENCE)
  })

  it('快用完：照舊（沒停）', () => {
    expect(quotaBannerDesc({ state: 'near', used: 42, limit: 50, pausedByCalls: false }))
      .toBe('本期已用 42 / 50 則。用完後需要 AI 回答的問題會改為轉給真人客服（自動回應不受影響）。')
  })
})
