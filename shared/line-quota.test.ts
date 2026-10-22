import { describe, expect, it } from 'vitest'
import {
  lineQuotaAlertDetail,
  lineQuotaConsequence,
  lineQuotaFromLine,
  lineQuotaHint,
  lineQuotaLevel,
  lineQuotaResetLabel,
  lineQuotaShortfall,
  lineQuotaStrip,
  lineQuotaWarning,
  lineQuotaWarnNotifyText,
} from './line-quota'

/** 台灣時間 2026-10-22 10:00 */
const OCT22 = new Date('2026-10-22T10:00:00+08:00')

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
      .toMatchObject({ text: 'LINE 這個月還剩約 2,790 則', level: 'ok' })
  })

  it('⭐ 滑過去講清楚：上限多少、含加購的（不是免費還剩這麼多）、已送幾則、AI 回客人不算', () => {
    const t = lineQuotaHint({ limit: 306000, used: 6810, remaining: 299190 })!.title
    expect(t).toContain('上限 306,000 則')
    expect(t).toContain('方案內含＋加購')
    expect(t).toContain('已送約 6,810 則')
    expect(t).toContain('活動頁加好友後送的那則')
    expect(t).toContain('AI 回客人不算')
  })

  it('`D-146` 用到八成就換黃（跟登入後第一頁、小幫手同一把尺）；差一則還不換', () => {
    expect(lineQuotaHint({ limit: 3000, used: 2400, remaining: 600 })).toMatchObject({ text: 'LINE 這個月還剩約 600 則', level: 'near' })
    expect(lineQuotaHint({ limit: 3000, used: 2399, remaining: 601 })?.level).toBe('ok')
  })

  it('用完了 → 講用完了、紅（`D-146`：以前用完也是黃，跟其他地方對不起來）', () => {
    expect(lineQuotaHint({ limit: 200, used: 205, remaining: 0 }))
      .toMatchObject({ text: 'LINE 這個月的 200 則用完了', level: 'over' })
  })

  it('沒設上限 → 講已送幾則，滑過去講超過會另外收費', () => {
    const h = lineQuotaHint({ limit: null, used: 4210, remaining: null })
    expect(h).toMatchObject({ text: 'LINE 這個月已送約 4,210 則（沒設上限）', level: 'ok' })
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

/**
 * `D-146`：登入後第一頁那一條、小幫手、八成那則 LINE 通知都吃這幾支。
 */
describe('快用完／用完了的尺', () => {
  it('八成＝near、剩 0＝over、沒設上限永遠 ok、⛔ 讀不到是 null（不是 ok）', () => {
    expect(lineQuotaLevel({ limit: 3000, used: 2399, remaining: 601 })).toBe('ok')
    expect(lineQuotaLevel({ limit: 3000, used: 2400, remaining: 600 })).toBe('near')
    expect(lineQuotaLevel({ limit: 3000, used: 3010, remaining: 0 })).toBe('over')
    expect(lineQuotaLevel({ limit: null, used: 999999, remaining: null })).toBe('ok')
    expect(lineQuotaLevel(null)).toBeNull()
  })

  it('幾號重算：台灣時間的下個月 1 號；12 月跨年回 1/1；10/31 晚上 11 點半還是 11/1', () => {
    expect(lineQuotaResetLabel(OCT22)).toBe('11/1')
    expect(lineQuotaResetLabel(new Date('2026-12-15T10:00:00+08:00'))).toBe('1/1')
    expect(lineQuotaResetLabel(new Date('2026-10-31T23:30:00+08:00'))).toBe('11/1')
  })

  it('⭐ 後果那句：用完／快用完都講三件送不出去的事＋AI 回客人不受影響（拿掉會被讀成整個 LINE 都停了）', () => {
    for (const level of ['over', 'near'] as const) {
      const s = lineQuotaConsequence(level, '11/1')
      expect(s).toContain('推播、你在後台回客人的訊息、傳給你的 LINE 通知')
      expect(s).toContain('11/1')
      expect(s).toContain('AI 回客人')
    }
  })
})

describe('登入後第一頁那一條', () => {
  it('平常：還剩約幾則＋已送／上限・幾號重算，沒有後果那一行', () => {
    expect(lineQuotaStrip({ limit: 306000, used: 6810, remaining: 299190 }, OCT22)).toMatchObject({
      level: 'ok',
      main: '這個月還剩約 299,190 則',
      meta: '已送約 6,810／上限 306,000・11/1 重算',
      usedPercent: 2.2,
      note: null,
    })
  })

  it('八成：多一行「快用完了：…」', () => {
    const s = lineQuotaStrip({ limit: 3000, used: 2480, remaining: 520 }, OCT22)!
    expect(s.level).toBe('near')
    expect(s.main).toBe('這個月還剩約 520 則')
    expect(s.note).toBe(`快用完了：${lineQuotaConsequence('near', '11/1')}`)
  })

  it('用完：主句換成「這個月的 N 則用完了」、進度條滿、講後果', () => {
    expect(lineQuotaStrip({ limit: 3000, used: 3012, remaining: 0 }, OCT22)).toMatchObject({
      level: 'over',
      main: '這個月的 3,000 則用完了',
      usedPercent: 100,
      note: lineQuotaConsequence('over', '11/1'),
    })
  })

  it('沒設上限：講已送幾則、沒有進度條', () => {
    expect(lineQuotaStrip({ limit: null, used: 4210, remaining: null }, OCT22)).toMatchObject({
      level: 'ok',
      main: '這個月已送約 4,210 則',
      meta: '沒設每月上限・11/1 重算',
      usedPercent: null,
      note: null,
    })
  })

  it('讀不到 → 整條不畫', () => {
    expect(lineQuotaStrip(null)).toBeNull()
  })
})

describe('小幫手那兩項、八成那則 LINE 通知', () => {
  it('補充那一行：用完＝已送／上限；快用完多帶百分比', () => {
    expect(lineQuotaAlertDetail({ limit: 3000, used: 3000, remaining: 0 }, OCT22)).toBe('已送約 3,000／3,000 則，11/1 重算')
    expect(lineQuotaAlertDetail({ limit: 3000, used: 2480, remaining: 520 }, OCT22)).toBe('這個月已送約 2,480／3,000 則（83%），11/1 重算')
  })

  it('八成那則：跟「⚠️ AI 用量預警」同一個樣子，講後果與去哪裡處理', () => {
    const t = lineQuotaWarnNotifyText({ limit: 3000, used: 2480, remaining: 520 }, OCT22)
    expect(t.split('\n')[0]).toBe('⚠️ LINE 訊息快用完了')
    expect(t).toContain('這個月已送約 2,480／3,000 則（約 83%），11/1 重算。')
    expect(t).toContain('LINE 官方帳號後台')
  })
})
