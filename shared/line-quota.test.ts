import { describe, expect, it } from 'vitest'
import { lineQuotaFromLine, lineQuotaHint, lineQuotaShortfall, lineQuotaWarning } from './line-quota'

/**
 * `C-380`：推播頁看得到 LINE 這個月還剩幾則，發送前人數比剩下的多就警告。
 */

describe('LINE 回的兩個數字合成一份', () => {
  it('有上限：剩下＝上限－已送', () => {
    expect(lineQuotaFromLine({ type: 'limited', value: 3000 }, { totalUsage: 210 }))
      .toEqual({ limit: 3000, used: 210, remaining: 2790 })
  })

  it('已送是大約數、可能比上限多一點 → 剩 0，⛔ 不是負數', () => {
    expect(lineQuotaFromLine({ type: 'limited', value: 200 }, { totalUsage: 203 })?.remaining).toBe(0)
  })

  it('沒設上限 → 只有已送，剩下是 null（沒有「不夠送」這回事）', () => {
    expect(lineQuotaFromLine({ type: 'none' }, { totalUsage: 4210 }))
      .toEqual({ limit: null, used: 4210, remaining: null })
  })

  it('⛔ 看不懂的格式回 null，不拿 0 冒充「用完了」', () => {
    expect(lineQuotaFromLine({ type: 'limited' }, { totalUsage: 10 })).toBeNull()
    expect(lineQuotaFromLine({ type: 'limited', value: 200 }, {})).toBeNull()
    expect(lineQuotaFromLine({ type: 'weird', value: 200 }, { totalUsage: 1 })).toBeNull()
    expect(lineQuotaFromLine(null, null)).toBeNull()
  })
})

describe('推播頁左邊那一行', () => {
  it('平常：還剩約幾則，不用提醒色', () => {
    expect(lineQuotaHint({ limit: 3000, used: 210, remaining: 2790 }))
      .toMatchObject({ text: 'LINE 這個月還剩約 2,790 則', warn: false })
  })

  it('⭐ 滑過去講清楚：上限多少、含加購的（不是免費還剩這麼多）、已送幾則、AI 回客人不算', () => {
    const t = lineQuotaHint({ limit: 306000, used: 6810, remaining: 299190 })!.title
    expect(t).toContain('上限 306,000 則')
    expect(t).toContain('方案內含＋加購')
    expect(t).toContain('已送約 6,810 則')
    expect(t).toContain('活動頁加好友後送的那則')
    expect(t).toContain('AI 回客人不算')
  })

  it('剩不到一成 → 換提醒色；剛好一成還不換', () => {
    expect(lineQuotaHint({ limit: 3000, used: 2701, remaining: 299 })).toMatchObject({ text: 'LINE 這個月還剩約 299 則', warn: true })
    expect(lineQuotaHint({ limit: 3000, used: 2700, remaining: 300 })?.warn).toBe(false)
  })

  it('用完了 → 講用完了、提醒色', () => {
    expect(lineQuotaHint({ limit: 200, used: 205, remaining: 0 }))
      .toMatchObject({ text: 'LINE 這個月的 200 則用完了', warn: true })
  })

  it('沒設上限 → 講已送幾則，滑過去講超過會另外收費', () => {
    const h = lineQuotaHint({ limit: null, used: 4210, remaining: null })
    expect(h).toMatchObject({ text: 'LINE 這個月已送約 4,210 則（沒設上限）', warn: false })
    expect(h!.title).toContain('另外收費')
  })

  it('讀不到 → 整行不顯示', () => {
    expect(lineQuotaHint(null)).toBeNull()
  })
})

describe('發送前確認：人數比剩下的則數多就警告', () => {
  const q = { limit: 3000, used: 2200, remaining: 800 }

  it('夠送（剛好等於也算夠）→ 不警告', () => {
    expect(lineQuotaShortfall(q, 800)).toBe(0)
    expect(lineQuotaWarning(q, 800)).toBeNull()
  })

  it('⭐ 不夠送 → 警告超過的人會收不到，並講去哪裡處理', () => {
    expect(lineQuotaShortfall(q, 1200)).toBe(400)
    const w = lineQuotaWarning(q, 1200)
    expect(w).toContain('超過的人會收不到')
    expect(w).toContain('LINE 官方帳號後台升級方案')
  })

  it('⭐ 用完了 → 講誰都收不到', () => {
    expect(lineQuotaWarning({ limit: 200, used: 200, remaining: 0 }, 5)).toContain('誰都收不到')
  })

  it('⛔ 句子裡不重複數字（兩格數字就並排在上面）', () => {
    expect(lineQuotaWarning(q, 1200)).not.toMatch(/\d/)
    expect(lineQuotaWarning({ limit: 200, used: 200, remaining: 0 }, 5)).not.toMatch(/\d/)
  })

  it('沒設上限、讀不到 → 不警告', () => {
    expect(lineQuotaWarning({ limit: null, used: 99999, remaining: null }, 100000)).toBeNull()
    expect(lineQuotaWarning(null, 100000)).toBeNull()
  })
})
