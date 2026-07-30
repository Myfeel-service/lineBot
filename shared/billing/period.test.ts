import { describe, expect, it } from 'vitest'
import { anchorDayOf, confirmRenewal, GRACE_DAYS, newSubscription, rollSubscriptionToCurrentPeriod } from './period'
import type { WorkspaceSubscription } from './plans'

const sub = (over: Partial<WorkspaceSubscription> & Pick<WorkspaceSubscription, 'planId'>): WorkspaceSubscription => ({
  status: 'active',
  currentPeriodStart: '2026-07-28',
  currentPeriodEnd: '2026-08-27',
  anchorDay: 28,
  ...over,
})

describe('anchorDayOf', () => {
  it('有 anchorDay → 直接用', () => {
    expect(anchorDayOf(sub({ planId: 'lite', anchorDay: 15 }))).toBe(15)
  })
  it('舊資料沒有 anchorDay → 由本期起日推回', () => {
    expect(anchorDayOf({ planId: 'lite', status: 'active', currentPeriodStart: '2026-07-09', currentPeriodEnd: null })).toBe(9)
  })
  it('什麼都沒有 → 1', () => {
    expect(anchorDayOf({ planId: 'free', status: 'active', currentPeriodStart: null, currentPeriodEnd: null })).toBe(1)
  })
})

describe('newSubscription', () => {
  it('錨定日預設 = 起始日當天,週期一整期', () => {
    expect(newSubscription('starter', '2026-07-28')).toEqual({
      planId: 'starter',
      status: 'active',
      currentPeriodStart: '2026-07-28',
      currentPeriodEnd: '2026-08-27',
      anchorDay: 28,
    })
  })
})

describe('rollSubscriptionToCurrentPeriod — 讀取時就地推算當期', () => {
  it('還在本期內 → 原封不動', () => {
    const r = rollSubscriptionToCurrentPeriod(sub({ planId: 'starter' }), '2026-08-10')
    expect(r.changed).toBe(false)
    expect(r.downgraded).toBe(false)
    expect(r.sub.currentPeriodStart).toBe('2026-07-28')
  })

  it('免費層過期 → 滾到下一期（額度歸零）,方案不變', () => {
    const r = rollSubscriptionToCurrentPeriod(sub({ planId: 'free' }), '2026-08-30')
    expect(r.changed).toBe(true)
    expect(r.downgraded).toBe(false)
    expect(r.sub.planId).toBe('free')
    expect(r.sub.currentPeriodStart).toBe('2026-08-28')
    expect(r.sub.currentPeriodEnd).toBe('2026-09-27')
  })

  it('付費方案到期沒續費 → 降回免費層', () => {
    const r = rollSubscriptionToCurrentPeriod(sub({ planId: 'pro' }), '2026-08-30')
    expect(r.downgraded).toBe(true)
    expect(r.sub.planId).toBe('free')
    expect(r.sub.status).toBe('active')
    expect(r.sub.currentPeriodStart).toBe('2026-08-28')
  })

  it('降級時特批額度（quotaOverride）一併失效', () => {
    const r = rollSubscriptionToCurrentPeriod(sub({ planId: 'pro', quotaOverride: 50_000 }), '2026-08-30')
    expect(r.sub.planId).toBe('free')
    expect(r.sub.quotaOverride).toBeUndefined()
  })

  it('enterprise / internal 不會被自動降級（走合約 / 由人管理）', () => {
    expect(rollSubscriptionToCurrentPeriod(sub({ planId: 'enterprise' }), '2026-08-30').sub.planId).toBe('enterprise')
    expect(rollSubscriptionToCurrentPeriod(sub({ planId: 'internal' }), '2026-08-30').sub.planId).toBe('internal')
    expect(rollSubscriptionToCurrentPeriod(sub({ planId: 'test' }), '2026-08-30').sub.planId).toBe('test')
  })

  it('休眠很久（跳過好幾期）→ 一路滾到當期,只降一次級', () => {
    const r = rollSubscriptionToCurrentPeriod(sub({ planId: 'pro' }), '2026-12-05')
    expect(r.sub.planId).toBe('free')
    // 7/28 起每月 28 號續期 → 包含 12/05 的那一期是 11/28 ~ 12/27
    expect(r.sub.currentPeriodStart).toBe('2026-11-28')
    expect(r.sub.currentPeriodEnd).toBe('2026-12-27')
  })

  it('舊資料沒有週期 → 就地補一期並補上 anchorDay', () => {
    const r = rollSubscriptionToCurrentPeriod(
      { planId: 'free', status: 'active', currentPeriodStart: null, currentPeriodEnd: null },
      '2026-07-28',
    )
    expect(r.changed).toBe(true)
    expect(r.sub).toMatchObject({ currentPeriodStart: '2026-07-28', currentPeriodEnd: '2026-08-27', anchorDay: 28 })
  })

  it('推算是冪等的：滾過一次之後再滾不會再變', () => {
    const once = rollSubscriptionToCurrentPeriod(sub({ planId: 'pro' }), '2026-08-30')
    const twice = rollSubscriptionToCurrentPeriod(once.sub, '2026-08-30')
    expect(twice.changed).toBe(false)
    expect(twice.sub).toEqual(once.sub)
  })

  it('舊版寫成完整 ISO 的起日 → 正規化成 YYYY-MM-DD（否則會變成額度桶的 doc id）', () => {
    const r = rollSubscriptionToCurrentPeriod(
      { planId: 'free', status: 'active', currentPeriodStart: '2026-07-03T00:00:00.000Z', currentPeriodEnd: null },
      '2026-07-28',
    )
    expect(r.sub.currentPeriodStart).toBe('2026-07-03')
    expect(r.sub.currentPeriodEnd).toBe('2026-08-02')
    expect(r.sub.anchorDay).toBe(3)
  })
})

// ── 自動續訂的寬限期 ──────────────────────────────────────────────
//
// 續扣是在「錨定日當天」由排程發動的,可能晚幾小時（甚至遇到 UNKNOWN 要等查單補查）。
// 若一到期就降級,客戶每個月都會斷線一段時間——這組測試就是在釘死這件事不會發生。
describe('rollSubscriptionToCurrentPeriod — 自動續訂的寬限期', () => {
  const autoRenewing = (over: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription => ({
    planId: 'starter',
    status: 'active',
    currentPeriodStart: '2026-07-28',
    currentPeriodEnd: '2026-08-27',
    anchorDay: 28,
    autoRenew: true,
    // 寬限期的前提是「真的有一筆扣款會來」= 有生效中的約定卡
    payuniCardToken: 'HASH1',
    ...over,
  })

  it('到期當天扣款通知還沒到 → 進 past_due,方案不變（服務照跑、額度照給）', () => {
    const r = rollSubscriptionToCurrentPeriod(autoRenewing(), '2026-08-28')
    expect(r.downgraded).toBe(false)
    expect(r.sub.planId).toBe('starter') // ← 沒被降級,這是重點
    expect(r.sub.status).toBe('past_due')
    expect(r.sub.currentPeriodStart).toBe('2026-08-28') // 已滾到新一期 → 額度歸零
  })

  it(`寬限期內（${GRACE_DAYS} 天）維持 past_due，方案仍在`, () => {
    const r = rollSubscriptionToCurrentPeriod(autoRenewing(), '2026-08-30')
    expect(r.sub.planId).toBe('starter')
    expect(r.sub.status).toBe('past_due')
  })

  it('寬限期滿仍未扣款成功 → 才真的降回免費層', () => {
    const r = rollSubscriptionToCurrentPeriod(autoRenewing(), '2026-09-01') // 8/28 + 3 天 < 9/1
    expect(r.downgraded).toBe(true)
    expect(r.sub.planId).toBe('free')
    expect(r.sub.status).toBe('active')
    expect(r.sub.autoRenew).toBe(false)
  })

  it('降級**必須保留約定卡 Token** —— 那張卡在 PAYUNi 還綁著', () => {
    // Token 刪掉 = 我方再也認不得那張約定 → 解約 API 找不到它,客戶反悔想恢復訂閱也沒得用。
    // （留著不會自己扣款:autoRenew 已成 false,沒有任何排程會扣他。）
    const r = rollSubscriptionToCurrentPeriod(autoRenewing(), '2026-09-01')
    expect(r.sub.planId).toBe('free')
    expect(r.sub.payuniCardToken).toBe('HASH1') // ← 留著,解約與恢復訂閱都要用
    expect(r.sub.autoRenew).toBe(false) // 但不會再有人扣他的卡
  })

  it('降級後不會卡在 past_due（免費層不在寬限期邏輯的管轄內，狀態會永遠清不掉）', () => {
    // 扣款失敗 → past_due → 降級成 free，但若之後又有一則失敗通知把 free 標成 past_due，
    // 沒有這條清理就會永遠卡住：帳單頁一直紅字、取消入口被蓋掉。
    const stuck = rollSubscriptionToCurrentPeriod(
      { planId: 'free', status: 'past_due', currentPeriodStart: '2026-08-28', currentPeriodEnd: '2026-09-27', anchorDay: 28 },
      '2026-09-01',
    )
    expect(stuck.sub.status).toBe('active')
    expect(stuck.changed).toBe(true)
  })

  it('已按下取消（期末生效）→ 不走寬限期，期末直接降回免費層', () => {
    const r = rollSubscriptionToCurrentPeriod(
      autoRenewing({ autoRenew: false, cancelAtPeriodEnd: true }),
      '2026-08-28',
    )
    expect(r.downgraded).toBe(true)
    expect(r.sub.planId).toBe('free')
  })

  it('沒有自動續訂（單次付款）→ 到期即降級，不給寬限期', () => {
    const r = rollSubscriptionToCurrentPeriod(autoRenewing({ autoRenew: false }), '2026-08-28')
    expect(r.downgraded).toBe(true)
    expect(r.sub.planId).toBe('free')
  })
})

describe('confirmRenewal — 收到扣款成功通知', () => {
  const pastDue: WorkspaceSubscription = {
    planId: 'starter',
    status: 'past_due',
    currentPeriodStart: '2026-08-28',
    currentPeriodEnd: '2026-09-27',
    anchorDay: 28,
    autoRenew: true,
  }

  it('寬限中收到通知 → 回到 active，本期不變', () => {
    const s = confirmRenewal(pastDue, '2026-08-28', { planId: 'starter' })
    expect(s.status).toBe('active')
    expect(s.planId).toBe('starter')
    expect(s.currentPeriodStart).toBe('2026-08-28') // 同一期,不是再開一期
  })

  it('通知遲到、已被降成免費層 → 方案由訂單復原，客戶不會付了錢只拿到 200 則', () => {
    // 這正是 confirmRenewal 必須收 planId 而不能沿用 roll 結果的原因
    const downgraded: WorkspaceSubscription = {
      planId: 'free',
      status: 'active',
      currentPeriodStart: '2026-08-28',
      currentPeriodEnd: '2026-09-27',
      anchorDay: 28,
      autoRenew: false,
    }
    const s = confirmRenewal(downgraded, '2026-09-02', { planId: 'starter' })
    expect(s.planId).toBe('starter')
    expect(s.status).toBe('active')
    expect(s.autoRenew).toBe(true)
  })

  it('已按下取消 → 續期通知**不得**把 autoRenew 打開（系統不能自己撤銷客戶的取消）', () => {
    // 情境：客戶 27 號按下取消，28 號那筆續扣已經在路上（競態），錢扣到了。
    // 該給的一期照給，但絕不能復活訂閱——否則帳單頁會顯示一個永遠不會發生的「下次扣款日」，
    // 客戶的取消也從紀錄上消失了。
    const canceled: WorkspaceSubscription = {
      planId: 'starter',
      status: 'active',
      currentPeriodStart: '2026-07-28',
      currentPeriodEnd: '2026-08-27',
      anchorDay: 28,
      autoRenew: false,
      cancelAtPeriodEnd: true,
    }
    const s = confirmRenewal(canceled, '2026-08-28', { planId: 'starter' })
    expect(s.planId).toBe('starter') // 錢收了，這一期照給
    expect(s.autoRenew).toBe(false) // ← 但取消依然有效
    expect(s.cancelAtPeriodEnd).toBe(true)
  })
})

// ── autoRenew 旗標為真但**沒有扣款憑證** ────────────────────────────────
//
// 生產真的有這種資料（手動塞的測試訂閱:autoRenew=true、periodNo 是假的、沒有約定卡）。
// 這種帳號不會有任何排程去扣他,讓他躺在寬限期只是白給 3 天 + 在帳單頁顯示一個
// 誤導的紅色「這期的自動扣款尚未成功」,3 天後照樣降級。
describe('rollSubscriptionToCurrentPeriod — autoRenew 但沒有約定卡', () => {
  const noMandate = (over: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription => ({
    planId: 'starter',
    status: 'active',
    currentPeriodStart: '2026-07-28',
    currentPeriodEnd: '2026-08-27',
    anchorDay: 28,
    autoRenew: true,
    ...over,
  })

  it('沒有 payuniCardToken → **不進寬限期**,直接降回免費層', () => {
    const r = rollSubscriptionToCurrentPeriod(noMandate(), '2026-08-28')
    expect(r.sub.status).toBe('active')
    expect(r.sub.planId).toBe('free')
    expect(r.downgraded).toBe(true)
  })

  it('殘留藍新 periodNo 也不算憑證（那套程式已移除,不會有人來扣款）', () => {
    const r = rollSubscriptionToCurrentPeriod(
      noMandate({ periodNo: 'SELFPTN0001', periodOrderNo: 'NPSELFPERIOD01' }),
      '2026-08-28',
    )
    expect(r.sub.planId).toBe('free')
    expect(r.downgraded).toBe(true)
  })

  it('有 payuniCardToken → 照原本邏輯進寬限期（對照組）', () => {
    const r = rollSubscriptionToCurrentPeriod(noMandate({ payuniCardToken: 'HASH1' }), '2026-08-28')
    expect(r.sub.status).toBe('past_due')
    expect(r.sub.planId).toBe('starter')
    expect(r.downgraded).toBe(false)
  })
})
