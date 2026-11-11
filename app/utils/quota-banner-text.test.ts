/**
 * 後台額度橫幅（與方案頁那格）的說法：兩種「AI 停了」要分得出原因（`C-8`），後果那句一字不差（`C-341`）。
 */
import { describe, expect, it } from 'vitest'
import { QUOTA_STOPPED_CONSEQUENCE, aiCallPausedText, daysUntilQuotaOut, isPausedByCalls, quotaBannerDesc, quotaBannerTitle, quotaResetNotice } from './quota-banner-text'

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

  it('快用完：先講他賺到什麼，再講後果（`D-180`）', () => {
    const t = quotaBannerDesc({ state: 'near', used: 42, limit: 50, pausedByCalls: false })
    expect(t).toBe('本期 AI 已經幫你處理了 42 次客人提問（額度 50 則）。用完後需要 AI 回答的問題會改為轉給真人客服（自動回應不受影響）。')
    // ⛔ 一則＝AI 出手處理一次（同一個客人問五題就是五則），講成「幾個客人」是誇大
    expect(t).not.toContain('個客人的問題')
    // ⛔ 同一句裡不可以混用「這個月」與「本期」：一期是錨定日制、不是日曆月
    expect(t).not.toContain('這個月')
    // ⛔ 舊的寫法整段只講失去，不可以退回去
    expect(t).not.toContain('本期已用 42 / 50 則')
  })
})

describe('daysUntilQuotaOut — 照目前速度還能撐幾天（`D-180`）', () => {
  const base = { limit: 50, periodStart: '2026-11-01' }

  it('用了 10 天 40 則＝每天 4 則，剩 10 則→約 3 天', () => {
    // 11-01 ~ 11-10 ＝ 10 天（起訖皆含當日）；10 / 4 = 2.5 → 無條件進位 3
    expect(daysUntilQuotaOut({ ...base, used: 40, today: '2026-11-10' })).toBe(3)
  })

  it('⛔ 只有一天的資料不猜（速度會亂跳）', () => {
    expect(daysUntilQuotaOut({ ...base, used: 40, today: '2026-11-01' })).toBeNull()
  })

  it('⛔ 一則都還沒用、已經用完、沒有上限、沒有起日 → 都回 null', () => {
    expect(daysUntilQuotaOut({ ...base, used: 0, today: '2026-11-10' })).toBeNull()
    expect(daysUntilQuotaOut({ ...base, used: 50, today: '2026-11-10' })).toBeNull()
    expect(daysUntilQuotaOut({ ...base, limit: null, used: 10, today: '2026-11-10' })).toBeNull()
    expect(daysUntilQuotaOut({ ...base, periodStart: null, used: 10, today: '2026-11-10' })).toBeNull()
  })

  it('⛔ 用得很慢（算出一個月以上）不講——那句話對他沒意義，還像在催', () => {
    // 10 天才用 1 則＝每天 0.1 則，剩 49 則要 490 天
    expect(daysUntilQuotaOut({ ...base, used: 1, today: '2026-11-10' })).toBeNull()
  })

  it('算出不到一天也至少講 1 天（⛔ 不會出現「約 0 天後用完」）', () => {
    expect(daysUntilQuotaOut({ limit: 50, periodStart: '2026-11-01', used: 49, today: '2026-11-02' })).toBe(1)
  })
})

describe('quotaBannerTitle', () => {
  it('快用完：剩幾則＋大約幾天後用完', () => {
    expect(quotaBannerTitle({ state: 'near', pausedByCalls: false, remaining: 10, daysLeft: 2 }))
      .toBe('AI 回覆本期只剩 10 則，約 2 天後用完')
  })

  it('算不出天數就只講剩幾則（⛔ 不硬給一個數字）', () => {
    expect(quotaBannerTitle({ state: 'near', pausedByCalls: false, remaining: 10, daysLeft: null }))
      .toBe('AI 回覆本期只剩 10 則')
  })

  it('已經停了（則數用完、或被叫太多次）一律講「已停止」，不講還剩幾則', () => {
    expect(quotaBannerTitle({ state: 'over', pausedByCalls: false, remaining: 0, daysLeft: null })).toBe('AI 已停止自動回覆')
    expect(quotaBannerTitle({ state: 'ok', pausedByCalls: true, remaining: 38, daysLeft: 5 })).toBe('AI 已停止自動回覆')
  })
})

describe('quotaResetNotice — 不升級的話什麼時候會自己好（`D-180`）', () => {
  it('講得出本期結束那一天', () => {
    expect(quotaResetNotice('2026-12-03')).toBe('不升級的話，本期結束（12 月 3 日）後會自動恢復。')
    // ⛔ 日期不可以黏在「本期」前面：「12 月 3 日本期結束」會被先讀成「日本」
    expect(quotaResetNotice('2026-12-03')).not.toContain('日本期')
  })

  it('⛔ 沒有本期結束日（舊資料）就整句不講，不瞎掰', () => {
    expect(quotaResetNotice(null)).toBe('')
    expect(quotaResetNotice('')).toBe('')
    expect(quotaResetNotice('2026-12')).toBe('')
  })
})
