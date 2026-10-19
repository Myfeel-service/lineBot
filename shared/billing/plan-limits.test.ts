/**
 * 方案功能閘門與額度階梯的守門測試（`D-69`）。
 *
 * 為什麼要有：這幾個欄位在 2026-09-07 以前**只印在方案表上、後端零攔截**，
 * 沒有任何測試看著它們。把「哪個方案有什麼」寫成斷言，改錯就會紅。
 */
import { describe, expect, it } from 'vitest'
import {
  BILLING_PLANS,
  BROADCAST_TIER_CELL,
  FEATURED_PLAN_IDS,
  OVERAGE_PER_REPLY_TWD,
  broadcastLockText,
  broadcastPlanBlockReason,
  broadcastTierSpec,
  broadcastTierSummary,
  planAllowsBroadcast,
  planAllowsReport,
  planAllowsScripting,
  planLimitMessage,
  tierAllowsAudience,
} from './plans'

describe('額度階梯（D-69 拍板①）', () => {
  it('免費層必須嚴格小於最低付費方案——同量的話付費方案賣不動', () => {
    expect(BILLING_PLANS.free.answeredQuota!).toBeLessThan(BILLING_PLANS.lite.answeredQuota!)
  })

  it('回覆則數與知識量在檯面上的四個方案都逐級遞增', () => {
    const quotas = FEATURED_PLAN_IDS.map(id => BILLING_PLANS[id].answeredQuota!)
    const chunks = FEATURED_PLAN_IDS.map(id => BILLING_PLANS[id].knowledgeChunks!)
    expect(quotas).toEqual([...quotas].sort((a, b) => a - b))
    expect(chunks).toEqual([...chunks].sort((a, b) => a - b))
  })

  it('每則單價隨方案變便宜（買越多越划算，這是升級的數學理由）', () => {
    const paid = ['lite', 'starter', 'growth'] as const
    const unit = paid.map(id => BILLING_PLANS[id].priceMonthly! / BILLING_PLANS[id].answeredQuota!)
    expect(unit[1]).toBeLessThan(unit[0]!)
    expect(unit[2]).toBeLessThan(unit[1]!)
  })

  /**
   * 這條是 `D-69` 拍板②的整個理由，值得一條測試釘住：
   * 超量加購若比「升一級」便宜，客人就永遠卡在低階方案。
   */
  it('長期超量必須比升級貴——否則階梯推不動人', () => {
    const lite = BILLING_PLANS.lite
    const starter = BILLING_PLANS.starter
    const extra = starter.answeredQuota! - lite.answeredQuota!
    const costViaOverage = lite.priceMonthly! + extra * OVERAGE_PER_REPLY_TWD
    expect(costViaOverage).toBeGreaterThan(starter.priceMonthly!)
  })
})

describe('功能閘門（D-69 拍板④）', () => {
  // 2026-09-26 老闆拍板「統一就都開放腳本功能」：開帳精靈的歡迎訊息是一條 follow 腳本，
  // 免費／輕量擋掉的話精靈那一步就兌現不了（按採用＝403）
  it('腳本：所有方案都開放（含免費、輕量）', () => {
    for (const id of Object.keys(BILLING_PLANS) as (keyof typeof BILLING_PLANS)[]) {
      expect(planAllowsScripting(BILLING_PLANS[id]), id).toBe(true)
    }
  })

  it('群發：免費完全不能發；輕量可全體推播但不能分眾；成長才有分眾', () => {
    expect(planAllowsBroadcast(BILLING_PLANS.free, 'basic')).toBe(false)
    expect(planAllowsBroadcast(BILLING_PLANS.lite, 'basic')).toBe(true)
    expect(planAllowsBroadcast(BILLING_PLANS.lite, 'advanced')).toBe(false)
    expect(planAllowsBroadcast(BILLING_PLANS.growth, 'advanced')).toBe(true)
  })

  /**
   * `D-131`：前端鎖選項、後端擋端點用的 `tierAllowsAudience` 必須跟送出端的規則（`planAllowsBroadcast`＋
   * 「全部好友要 basic、其餘要 advanced」）逐一相同——漂開就是「畫面鎖了、送出端放行」或反過來。
   */
  it('推播：鎖選項的判斷跟送出端的規則逐方案、逐對象一致', () => {
    for (const plan of Object.values(BILLING_PLANS)) {
      for (const type of ['all', 'tags', 'audience', 'import']) {
        const need = type === 'all' ? 'basic' : 'advanced'
        expect(tierAllowsAudience(plan.broadcast, type), `${plan.id}/${type}`).toBe(planAllowsBroadcast(plan, need))
        expect(broadcastPlanBlockReason(plan.broadcast, type) === null, `${plan.id}/${type}`).toBe(planAllowsBroadcast(plan, need))
      }
    }
  })

  it('報表：等級可比較，export 是最高階', () => {
    expect(planAllowsReport(BILLING_PLANS.free, 'advanced')).toBe(false)
    expect(planAllowsReport(BILLING_PLANS.growth, 'advanced')).toBe(true)
    expect(planAllowsReport(BILLING_PLANS.growth, 'export')).toBe(false)
    expect(planAllowsReport(BILLING_PLANS.enterprise, 'export')).toBe(true)
  })

  it('內部／企業方案一律不受限（席次與知識量都是 null）', () => {
    for (const id of ['enterprise', 'test', 'internal'] as const) {
      expect(BILLING_PLANS[id].seats).toBeNull()
      expect(BILLING_PLANS[id].knowledgeChunks).toBeNull()
    }
  })
})

/**
 * `D-131`①：推播分級對外的說法。每個面向（官網方案卡、付款彈窗、條款、/product-info、推播頁鎖住、驗證視窗、
 * 送出／排程被擋）都用這幾支——這裡把「講的是真的」釘住：說得出要哪個方案，而且那個方案真的發得了。
 */
describe('推播分級的說法（D-131）', () => {
  it('方案卡與付款彈窗：檯面上四個方案各寫一格，同一組字', () => {
    expect(FEATURED_PLAN_IDS.map(id => broadcastTierSpec(BILLING_PLANS[id].broadcast)))
      .toEqual(['不含推播', '推播：全部好友', '推播：全部好友', '推播：全部好友＋分眾'])
    expect(FEATURED_PLAN_IDS.map(id => BROADCAST_TIER_CELL[BILLING_PLANS[id].broadcast]))
      .toEqual(['—', '全部好友', '全部好友', '全部好友＋分眾'])
  })

  it('鎖住時講得出要哪個方案以上，而且那個方案真的發得了', () => {
    expect(broadcastLockText('basic')).toBe('目前的方案只能發給全部好友；依標籤篩選、匯入名單要成長以上的方案才能用。')
    expect(broadcastLockText('none')).toBe('目前的方案不能發推播，要輕量以上的方案才能發。')
    expect(broadcastLockText('advanced')).toBeNull()
    expect(planAllowsBroadcast(BILLING_PLANS.growth, 'advanced')).toBe(true)
    expect(planAllowsBroadcast(BILLING_PLANS.lite, 'basic')).toBe(true)
  })

  it('⛔ 鎖住那句不寫目前是哪個方案（推播頁客服也看得到，方案名屬計費資訊 G-103）', () => {
    for (const t of ['none', 'basic'] as const) {
      expect(broadcastLockText(t)).not.toMatch(/免費方案|輕量方案|入門方案/)
    }
  })

  it('條款與 /product-info 那一句照方案表導出', () => {
    expect(broadcastTierSummary()).toBe('免費方案不含推播；輕量、入門方案可推播給全部好友；成長方案另可依標籤篩選或匯入名單挑人發（分眾）。')
  })
})

describe('撞上限的訊息', () => {
  /**
   * ⛔ 只說「已達上限」等於沒說——客人只能來問客服。
   * 三個數字都要在：現在幾個、上限幾個、方案叫什麼。
   */
  it('把現況、上限、方案名都講出來，並給出路', () => {
    const msg = planLimitMessage('團隊成員數', 2, 2, '輕量')
    expect(msg).toContain('2／2')
    expect(msg).toContain('輕量')
    expect(msg).toMatch(/升級/)
  })

  it('帶量詞時數字後面接單位（知識量「50／50 條」，2026-10-17 前少了「條」）', () => {
    expect(planLimitMessage('AI 知識量', 50, 50, '免費', '條')).toContain('（50／50 條）')
  })
})
