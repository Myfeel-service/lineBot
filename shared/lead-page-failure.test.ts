import { describe, expect, it } from 'vitest'
import { LEAD_FAILURE_LABELS, LEAD_FAILURE_REASONS, summarizeLeadFailures } from './lead-page-failure'

/**
 * 這支釘的是 2026-09-13 那次改版的三條規矩（`G-90`）。原本的畫面把六種失敗並排成
 * 一張紅色清單、每列都附「去哪裡改什麼」——其中兩種商家根本沒有設定可以改，
 * 而且佔了絕大多數（94/117），所以商家看到的是一塊紅色、一堆做不到的指示，
 * 以及一個沒有分母的嚇人數字。
 */

const base = { total: 0, succeeded: 0, days: 7 }

describe('每一種失敗都要標明商家動不動得了', () => {
  it('六種都有 owner 欄位，沒有漏標的', () => {
    for (const r of LEAD_FAILURE_REASONS)
      expect(typeof LEAD_FAILURE_LABELS[r].owner).toBe('boolean')
  })

  it('⛔ 商家動不了的那幾種，下一步不可以叫人去改設定', () => {
    for (const r of LEAD_FAILURE_REASONS) {
      const { owner, hint } = LEAD_FAILURE_LABELS[r]
      if (owner) continue
      expect(hint).not.toMatch(/到「組織與 LINE」|重新發|填好/)
    }
  })
})

describe('只有商家動得了的項目才列出來、才點紅燈', () => {
  it('全是客人網路問題時＝不列任何待辦、不點紅燈', () => {
    const s = summarizeLeadFailures({
      ...base,
      byReason: { load_timeout: 94, claim_failed: 7 },
      total: 101,
      succeeded: 812,
    })
    expect(s.ownerRows).toEqual([])
    expect(s.notOwnerTotal).toBe(101)
    expect(s.tone).toBe('warning')
  })

  it('有連結不完整這種商家處理得掉的 → 列出來並點紅燈，動不了的收成一個數字', () => {
    const s = summarizeLeadFailures({
      ...base,
      byReason: { load_timeout: 94, claim_failed: 7, link_incomplete: 10, liff_init_failed: 6 },
      total: 117,
      succeeded: 812,
    })
    expect(s.ownerRows.map(r => r.reason)).toEqual(['link_incomplete', 'liff_init_failed'])
    expect(s.notOwnerTotal).toBe(101)
    expect(s.tone).toBe('critical')
    expect(s.needsBlock).toBe(true)
    // 標題要同時講「總共幾次」與「你可以處理幾次」，不然商家會以為 117 次都要自己扛
    expect(s.blockTitle).toContain('117')
    expect(s.blockTitle).toContain('16')
  })

  it('「點到已停用的活動」不是故障，不進待辦也不進那個數字', () => {
    const s = summarizeLeadFailures({ ...base, byReason: { campaign_inactive: 5 }, total: 5 })
    expect(s.ownerRows).toEqual([])
    expect(s.notOwnerTotal).toBe(0)
    expect(s.inactiveCount).toBe(5)
  })
})

describe('沒有分母就不准講比例', () => {
  it('succeeded=0 時 failPercent 是 null，而且畫面不會出現「0 人」', () => {
    const s = summarizeLeadFailures({ ...base, byReason: { load_timeout: 3 }, total: 3 })
    expect(s.failPercent).toBeNull()
    expect(s.quietLine).not.toMatch(/0 人/)
    expect(s.blockDetail).not.toMatch(/0 人/)
  })

  it('有分母就算得出比例，而且成功人數要講出來', () => {
    const s = summarizeLeadFailures({
      ...base,
      byReason: { load_timeout: 100 },
      total: 100,
      succeeded: 900,
    })
    expect(s.failPercent).toBe(10)
    expect(s.quietLine).toContain('900 人順利完成')
    expect(s.quietLine).toContain('10%')
  })
})

describe('什麼時候才值得升成一塊狀態卡', () => {
  it('沒有任何可動手項目、比例又低 → 只給一行字，不要嚇人', () => {
    const s = summarizeLeadFailures({
      ...base,
      byReason: { load_timeout: 94, claim_failed: 7 },
      total: 101,
      succeeded: 812,
    })
    expect(s.needsBlock).toBe(false)
  })

  it('比例高到不正常 → 即使商家動不了也要講（⛔ 不可以因為「反正他修不了」就整個藏起來）', () => {
    const s = summarizeLeadFailures({
      ...base,
      byReason: { load_timeout: 60 },
      total: 60,
      succeeded: 40,
    })
    expect(s.failPercent).toBe(60)
    expect(s.needsBlock).toBe(true)
    expect(s.tone).toBe('warning')
  })

  it('還沒有分母可用時退回看絕對數字', () => {
    expect(summarizeLeadFailures({ ...base, byReason: { load_timeout: 49 }, total: 49 }).needsBlock).toBe(false)
    expect(summarizeLeadFailures({ ...base, byReason: { load_timeout: 50 }, total: 50 }).needsBlock).toBe(true)
  })

  it('一次都沒失敗就不是問題（有成功數就把它講出來）', () => {
    const none = summarizeLeadFailures({ ...base, byReason: {}, total: 0 })
    expect(none.needsBlock).toBe(false)
    expect(none.quietLine).toBe('近 7 天沒有客人回報打不開活動頁。')

    const withOk = summarizeLeadFailures({ ...base, byReason: {}, total: 0, succeeded: 200 })
    expect(withOk.quietLine).toContain('200 人順利完成')
  })
})

describe('壞資料不可以把畫面弄出 NaN', () => {
  it('byReason 是 null／數字是垃圾時照樣算得出東西', () => {
    const s = summarizeLeadFailures({ byReason: null, total: Number.NaN, succeeded: -5, days: 7 })
    expect(s.ownerRows).toEqual([])
    expect(s.failTotal).toBe(0)
    expect(s.succeeded).toBe(0)
    expect(s.failPercent).toBeNull()
    expect(s.quietLine).not.toContain('NaN')
  })
})
