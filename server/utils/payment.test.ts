import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildPaidSubscription,
  INVOICE_ORDER_NO_MAX,
  newMerchantOrderNo,
  settlePaidOrder,
} from './payment'
import { invalidateWorkspaceSubscriptionCache } from './billing'
import type { WorkspaceSubscription } from '~~/shared/billing/plans'
import type { PaymentOrderDoc } from '~~/shared/types/payment'

// 2026-07-28（UTC 08:30 = 台灣 16:30）：月底,正是舊制會讓客戶「付整月只買到 3 天」的日子
const JUL28 = new Date(Date.UTC(2026, 6, 28, 8, 30, 15))

describe('buildPaidSubscription', () => {
  const existing = (over: Partial<WorkspaceSubscription> & Pick<WorkspaceSubscription, 'planId'>): WorkspaceSubscription => ({
    status: 'active', currentPeriodStart: '2026-07-28', currentPeriodEnd: '2026-08-27', anchorDay: 28, ...over,
  })

  it('無現有訂閱 → 從付款日起算完整一期（月底付款不再只買到月底）', () => {
    const sub = buildPaidSubscription('lite', JUL28)
    expect(sub).toEqual({
      planId: 'lite',
      status: 'active',
      currentPeriodStart: '2026-07-28',
      currentPeriodEnd: '2026-08-27',
      anchorDay: 28,
    })
    expect(sub.quotaOverride).toBeUndefined()
  })

  it('從免費層升級 → 立刻生效,錨定日重設為付款日（不接在免費期之後）', () => {
    const free = existing({ planId: 'free', currentPeriodStart: '2026-07-01', currentPeriodEnd: '2026-07-31', anchorDay: 1 })
    const sub = buildPaidSubscription('starter', JUL28, free)
    expect(sub.currentPeriodStart).toBe('2026-07-28')
    expect(sub.currentPeriodEnd).toBe('2026-08-27')
    expect(sub.anchorDay).toBe(28)
  })

  it('續訂同方案且未到期 → 期間堆疊、錨定日不變（提前續訂不白付）', () => {
    const sub = buildPaidSubscription('lite', JUL28, existing({ planId: 'lite' }))
    expect(sub.currentPeriodStart).toBe('2026-08-28')
    expect(sub.currentPeriodEnd).toBe('2026-09-27')
    expect(sub.anchorDay).toBe(28)
  })

  it('同方案但已過期 → 從付款日重新起算（不堆疊到過去）', () => {
    const sub = buildPaidSubscription('lite', JUL28, existing({ planId: 'lite', currentPeriodStart: '2026-05-01', currentPeriodEnd: '2026-05-31', anchorDay: 1 }))
    expect(sub.currentPeriodStart).toBe('2026-07-28')
  })

  it('換方案（升級）→ 立刻生效,不堆疊在舊方案之後', () => {
    const sub = buildPaidSubscription('pro', JUL28, existing({ planId: 'lite' }))
    expect(sub.planId).toBe('pro')
    expect(sub.currentPeriodStart).toBe('2026-07-28')
  })

  it('已解約的訂閱 → 不堆疊,從付款日重新起算', () => {
    const sub = buildPaidSubscription('lite', JUL28, existing({ planId: 'lite', status: 'canceled' }))
    expect(sub.currentPeriodStart).toBe('2026-07-28')
  })

  it('同方案續訂 → 保留 super admin 的 quotaOverride', () => {
    expect(buildPaidSubscription('pro', JUL28, existing({ planId: 'pro', quotaOverride: 15000 })).quotaOverride).toBe(15000)
  })

  it('換方案 → 不沿用舊 quotaOverride', () => {
    expect(buildPaidSubscription('pro', JUL28, existing({ planId: 'lite', quotaOverride: 15000 })).quotaOverride).toBeUndefined()
  })
})

describe('buildPaidSubscription — 錨定日', () => {
  it('錨定日沿用「建單時」存下的值，不在開通時重算（跨午夜會差一天）', () => {
    // 23:59 建單（錨定日 27）、00:00 開通：若在這裡用 now 重算就會拿到 28，
    // 之後每個月續扣排程在 27 號扣、我方在 28 號才續期 → 客戶每月被推進寬限期。
    const sub = buildPaidSubscription('starter', JUL28, null, {
      anchorDay: 27,
      payuniCard: { token: 'HASH1', last4: null, expiry: null },
    })
    expect(sub.anchorDay).toBe(27)
    expect(sub.currentPeriodEnd).toBe('2026-08-26') // 下一次錨定日 8/27 的前一天
    expect(sub.autoRenew).toBe(true)
  })
})

describe('newMerchantOrderNo', () => {
  it('NP + 12 碼時間 + 3 碼亂數 = 17 碼，僅英數', () => {
    const no = newMerchantOrderNo(new Date(Date.UTC(2026, 6, 20, 8, 30, 15)), 'AB1')
    expect(no).toBe('NP260720083015AB1')
    expect(no).toMatch(/^[0-9A-Za-z]+$/)
    expect(no).toHaveLength(17)
  })

  it('加上定期定額的期數後綴仍 ≤ 20 碼（ezPay 發票的自訂編號上限）', () => {
    // 藍新每期回拋的 OrderNo = `本單號_期數`。本單號一超過 17 碼，
    // 第 2 期之後的續期發票就會被 ezPay 全部退件——recurring 客戶一輩子只拿得到一張發票。
    const no = newMerchantOrderNo(new Date(Date.UTC(2026, 6, 20, 8, 30, 15)), 'AB1')
    expect(`${no}_99`.length).toBeLessThanOrEqual(INVOICE_ORDER_NO_MAX)
    expect(`${no}_99`).toMatch(/^[0-9A-Za-z_]+$/) // ezPay 限英數與底線
  })
})

// ── settlePaidOrder：以極簡 in-memory Firestore 模擬 transaction ──
function makeDb(initial: Record<string, unknown> = {}) {
  const store = new Map<string, any>(Object.entries(initial))
  const docRef = (collection: string, id: string) => ({
    _key: `${collection}/${id}`,
    async get() {
      const d = store.get(`${collection}/${id}`)
      return { exists: d !== undefined, data: () => d }
    },
    async create(data: any) {
      const k = `${collection}/${id}`
      if (store.has(k)) { const e: any = new Error('ALREADY_EXISTS'); e.code = 6; throw e }
      store.set(k, data)
    },
  })
  return {
    _store: store,
    collection: (c: string) => ({ doc: (id: string) => docRef(c, id) }),
    async runTransaction(fn: (tx: any) => any) {
      const tx = {
        get: (ref: any) => ref.get(),
        update: (ref: any, data: any) => store.set(ref._key, { ...(store.get(ref._key) || {}), ...data }),
        set: (ref: any, data: any) => store.set(ref._key, data),
      }
      return fn(tx)
    },
  }
}

function pendingOrder(over: Partial<PaymentOrderDoc> = {}): Record<string, unknown> {
  return { merchantOrderNo: 'NP1', workspaceId: 'ws1', planId: 'lite', amount: 499, status: 'pending', ...over }
}

describe('settlePaidOrder', () => {
  beforeEach(() => invalidateWorkspaceSubscriptionCache())

  it('pending + 付款成功 → 結算並原子開通訂閱（從付款日起算完整一期）', async () => {
    const db = makeDb({ 'paymentOrders/NP1': pendingOrder() }) as any
    const r = await settlePaidOrder({ merchantOrderNo: 'NP1', paid: true, amount: 499, tradeNo: 'T9', paymentType: 'CREDIT', now: JUL28 }, db)

    expect(r.outcome).toBe('settled')
    const order = db._store.get('paymentOrders/NP1')
    expect(order.status).toBe('paid')
    expect(order.tradeNo).toBe('T9')
    expect(order.periodStart).toBe('2026-07-28')

    const ws = db._store.get('workspaces/ws1')
    expect(ws.subscription).toMatchObject({ planId: 'lite', status: 'active', currentPeriodStart: '2026-07-28', currentPeriodEnd: '2026-08-27' })
  })

  it('帳號已有同方案的有效訂閱 → 結算時期間堆疊(提前續訂不白付)', async () => {
    const db = makeDb({
      'paymentOrders/NP1': pendingOrder({ planId: 'lite', amount: 499 }),
      'workspaces/ws1': { subscription: { planId: 'lite', status: 'active', currentPeriodStart: '2026-07-28', currentPeriodEnd: '2026-08-27', anchorDay: 28 } },
    }) as any
    await settlePaidOrder({ merchantOrderNo: 'NP1', paid: true, amount: 499, now: JUL28 }, db)
    expect(db._store.get('workspaces/ws1').subscription.currentPeriodStart).toBe('2026-08-28')
  })

  it('付款失敗 → 訂單 failed、不開通訂閱', async () => {
    const db = makeDb({ 'paymentOrders/NP1': pendingOrder() }) as any
    const r = await settlePaidOrder({ merchantOrderNo: 'NP1', paid: false, now: JUL28 }, db)

    expect(r.outcome).toBe('settled')
    expect(db._store.get('paymentOrders/NP1').status).toBe('failed')
    expect(db._store.get('workspaces/ws1')).toBeUndefined()
  })

  it('逾期單 + 這次確認已付款 → 復活開通（自動作廢後客戶才付款也不漏單、不吞錢）', async () => {
    const db = makeDb({ 'paymentOrders/NP1': pendingOrder({ status: 'expired' }) }) as any
    const r = await settlePaidOrder({ merchantOrderNo: 'NP1', paid: true, amount: 499, tradeNo: 'T9', now: JUL28 }, db)

    expect(r.outcome).toBe('settled')
    expect(db._store.get('paymentOrders/NP1').status).toBe('paid')
    expect(db._store.get('workspaces/ws1').subscription).toMatchObject({ planId: 'lite', status: 'active' })
  })

  it('逾期單 + 非付款成功 → 跳過、不動（不把 expired 改成 failed）', async () => {
    const db = makeDb({ 'paymentOrders/NP1': pendingOrder({ status: 'expired' }) }) as any
    const r = await settlePaidOrder({ merchantOrderNo: 'NP1', paid: false, now: JUL28 }, db)

    expect(r.outcome).toBe('already')
    expect(db._store.get('paymentOrders/NP1').status).toBe('expired')
    expect(db._store.get('workspaces/ws1')).toBeUndefined()
  })

  it('已結算（redelivery）→ 冪等跳過、不覆蓋', async () => {
    const db = makeDb({ 'paymentOrders/NP1': pendingOrder({ status: 'paid', tradeNo: 'ORIG' }) }) as any
    const r = await settlePaidOrder({ merchantOrderNo: 'NP1', paid: true, tradeNo: 'DUP', now: JUL28 }, db)

    expect(r.outcome).toBe('already')
    expect(db._store.get('paymentOrders/NP1').tradeNo).toBe('ORIG')
    expect(db._store.get('workspaces/ws1')).toBeUndefined()
  })

  it('查無訂單 → unknown', async () => {
    const db = makeDb() as any
    expect((await settlePaidOrder({ merchantOrderNo: 'NOPE', paid: true, now: JUL28 }, db)).outcome).toBe('unknown')
  })

  it('金額不符 → 標記失敗、不開通', async () => {
    const db = makeDb({ 'paymentOrders/NP1': pendingOrder({ amount: 499 }) }) as any
    const r = await settlePaidOrder({ merchantOrderNo: 'NP1', paid: true, amount: 1, now: JUL28 }, db)
    expect(r.amountMismatch).toBe(true)
    expect(db._store.get('paymentOrders/NP1').status).toBe('failed')
    expect(db._store.get('workspaces/ws1')).toBeUndefined()
  })
})


// ── PAYUNi 約定卡（Token 幕後續扣）────────────────────────────────────────────

describe('buildPaidSubscription — PAYUNi 約定卡（Token 續扣）', () => {
  const sub0 = (over: Partial<WorkspaceSubscription> & Pick<WorkspaceSubscription, 'planId'>): WorkspaceSubscription => ({
    status: 'active', currentPeriodStart: '2026-07-28', currentPeriodEnd: '2026-08-27', anchorDay: 28, ...over,
  })
  const card = { token: 'HASH1', last4: '1234', expiry: '0929' }

  it('帶約定卡 → 存 Token/末四碼/有效期,並開啟自動續訂', () => {
    const sub = buildPaidSubscription('lite', JUL28, null, { payuniCard: card })
    expect(sub.payuniCardToken).toBe('HASH1')
    expect(sub.payuniCardLast4).toBe('1234')
    expect(sub.payuniCardExpiry).toBe('0929')
    expect(sub.autoRenew).toBe(true)
    expect(sub.cancelAtPeriodEnd).toBe(false)
  })

  it('付款成功但沒建成約定 → **不**開自動續訂（否則會等一筆永不發生的續扣,把人卡到降級）', () => {
    const sub = buildPaidSubscription('lite', JUL28, null, { payuniCard: null })
    expect(sub.payuniCardToken).toBeUndefined()
    expect(sub.autoRenew).not.toBe(true)
  })

  it('PAYUNi **可以堆疊**（與藍新相反）:提前改自動續訂不吃掉已付的剩餘天數', () => {
    // 藍新不堆疊是因為金流端有自己固定的扣款日；PAYUNi 的扣款日由我方排程依
    // currentPeriodEnd 決定,不會錯開 → 沿用舊錨定日、接在到期日隔天才是對客戶公平的做法。
    const old = sub0({ planId: 'lite' })
    const sub = buildPaidSubscription('lite', JUL28, old, { payuniCard: card, anchorDay: 28 })
    expect(sub.currentPeriodStart).toBe('2026-08-28') // 接在 8/27 之後,不從今天重算
    expect(sub.anchorDay).toBe(28)
    expect(sub.payuniCardToken).toBe('HASH1')
  })

  it('這筆沒建新約定 → **沿用**既有 Token（弄丟就再也無法向 PAYUNi 解除約定）', () => {
    const old = sub0({ planId: 'lite', payuniCardToken: 'OLD', payuniCardLast4: '9999', autoRenew: true })
    const sub = buildPaidSubscription('lite', JUL28, old, {})
    expect(sub.payuniCardToken).toBe('OLD')
    expect(sub.payuniCardLast4).toBe('9999')
    expect(sub.autoRenew).toBe(true)
  })

  it('已取消的人手動補刷一期 → 不會偷偷把自動續訂打開', () => {
    const canceled = sub0({ planId: 'lite', payuniCardToken: 'OLD', autoRenew: false, cancelAtPeriodEnd: true })
    const sub = buildPaidSubscription('lite', JUL28, canceled, {})
    expect(sub.payuniCardToken).toBe('OLD') // Token 留著（解約還要用）
    expect(sub.autoRenew).toBe(false)
    expect(sub.cancelAtPeriodEnd).toBe(true)
  })
})

describe('settlePaidOrder — 約定卡以「訂單 kind」為閘門', () => {
  beforeEach(() => invalidateWorkspaceSubscriptionCache())
  const card = { token: 'HASH1', last4: '1234', expiry: '0929' }

  it('kind=period_first + 回傳 CreditHash → 存進訂閱,訂單記 cardBound/末四碼', async () => {
    const db = makeDb({ 'paymentOrders/NP1': pendingOrder({ kind: 'period_first', anchorDay: 28 }) }) as any
    const r = await settlePaidOrder({ merchantOrderNo: 'NP1', paid: true, amount: 499, payuniCard: card, now: JUL28 }, db)

    expect(r.outcome).toBe('settled')
    expect(r.cardBindFailed).toBe(false)
    expect(db._store.get('workspaces/ws1').subscription).toMatchObject({
      payuniCardToken: 'HASH1', payuniCardLast4: '1234', autoRenew: true,
    })
    const order = db._store.get('paymentOrders/NP1')
    expect(order.cardBound).toBe(true)
    expect(order.cardLast4).toBe('1234')
  })

  it('kind=one_time 卻回了 CreditHash → **不建立約定**（不能把單次付款變成每月扣款）', async () => {
    const db = makeDb({ 'paymentOrders/NP1': pendingOrder({ kind: 'one_time' }) }) as any
    const r = await settlePaidOrder({ merchantOrderNo: 'NP1', paid: true, amount: 499, payuniCard: card, now: JUL28 }, db)

    expect(r.outcome).toBe('settled')
    expect(r.cardBindFailed).toBe(false)
    const ws = db._store.get('workspaces/ws1')
    expect(ws.subscription.payuniCardToken).toBeUndefined()
    expect(ws.subscription.autoRenew).not.toBe(true)
    expect(db._store.get('paymentOrders/NP1').cardBound).toBe(false)
  })

  it('沒有 kind 的舊訂單（視為 one_time）同樣不建立約定', async () => {
    const db = makeDb({ 'paymentOrders/NP1': pendingOrder() }) as any
    await settlePaidOrder({ merchantOrderNo: 'NP1', paid: true, amount: 499, payuniCard: card, now: JUL28 }, db)
    expect(db._store.get('workspaces/ws1').subscription.payuniCardToken).toBeUndefined()
  })

  it('kind=period_first 但沒拿到 Token → cardBindFailed（收了錢卻不會有下期扣款,要人看）', async () => {
    const db = makeDb({ 'paymentOrders/NP1': pendingOrder({ kind: 'period_first' }) }) as any
    const r = await settlePaidOrder({ merchantOrderNo: 'NP1', paid: true, amount: 499, payuniCard: null, now: JUL28 }, db)

    expect(r.outcome).toBe('settled') // 錢收了、服務照開
    expect(r.cardBindFailed).toBe(true)
    expect(db._store.get('workspaces/ws1').subscription.autoRenew).not.toBe(true)
  })
})

describe('settlePaidOrder — 續扣（period_recurring）確認當期,不是再開一期', () => {
  beforeEach(() => invalidateWorkspaceSubscriptionCache())

  /** 已被 roll 推進新一期、等扣款的自動續訂。 */
  const pastDue = {
    planId: 'lite', status: 'past_due', currentPeriodStart: '2026-08-28', currentPeriodEnd: '2026-09-27',
    anchorDay: 28, autoRenew: true, payuniCardToken: 'HASH1', lastChargeError: '卡片授權失敗',
  }
  const AUG28 = new Date(Date.UTC(2026, 7, 28, 0, 30, 0))

  it('續扣成功 → **同一期**轉 active（走 buildPaidSubscription 會變成客戶一次扣款拿兩個月）', async () => {
    const db = makeDb({
      'paymentOrders/R1': pendingOrder({ merchantOrderNo: 'R1', kind: 'period_recurring', anchorDay: 28 }),
      'workspaces/ws1': { subscription: pastDue },
    }) as any
    const r = await settlePaidOrder({ merchantOrderNo: 'R1', paid: true, amount: 499, now: AUG28 }, db)

    expect(r.outcome).toBe('settled')
    const sub = db._store.get('workspaces/ws1').subscription
    expect(sub.status).toBe('active')
    expect(sub.currentPeriodStart).toBe('2026-08-28') // ← 不是 2026-09-28
    expect(sub.currentPeriodEnd).toBe('2026-09-27')
    expect(sub.autoRenew).toBe(true)
    expect(sub.payuniCardToken).toBe('HASH1') // 約定卡留著,下一期還要用
    expect(sub.lastChargeError).toBeUndefined() // 上次的失敗原因已不成立,別留在畫面上
    // 帳本記的本期起訖要與訂閱一致（發票/對帳看這個）
    expect(db._store.get('paymentOrders/R1')).toMatchObject({ periodStart: '2026-08-28', periodEnd: '2026-09-27' })
  })

  it('續扣期間客戶已按取消 → 該給的一期照給,但不會把取消撤銷掉', async () => {
    const db = makeDb({
      'paymentOrders/R1': pendingOrder({ merchantOrderNo: 'R1', kind: 'period_recurring' }),
      'workspaces/ws1': { subscription: { ...pastDue, autoRenew: false, cancelAtPeriodEnd: true } },
    }) as any
    await settlePaidOrder({ merchantOrderNo: 'R1', paid: true, amount: 499, now: AUG28 }, db)

    const sub = db._store.get('workspaces/ws1').subscription
    expect(sub.status).toBe('active')
    expect(sub.autoRenew).toBe(false)
    expect(sub.cancelAtPeriodEnd).toBe(true)
  })

  it('續扣失敗 → 訂單標 failed 並留原因,訂閱不動（維持 past_due,降級交給 roll）', async () => {
    const db = makeDb({
      'paymentOrders/R1': pendingOrder({ merchantOrderNo: 'R1', kind: 'period_recurring' }),
      'workspaces/ws1': { subscription: pastDue },
    }) as any
    const r = await settlePaidOrder({ merchantOrderNo: 'R1', paid: false, failReason: '卡片授權失敗', now: AUG28 }, db)

    expect(r.outcome).toBe('settled')
    expect(db._store.get('paymentOrders/R1')).toMatchObject({ status: 'failed', failReason: '卡片授權失敗' })
    expect(db._store.get('workspaces/ws1').subscription).toMatchObject({ status: 'past_due', planId: 'lite' })
  })
})

describe('settlePaidOrder — 續扣落地降級與折抵（P4）', () => {
  beforeEach(() => invalidateWorkspaceSubscriptionCache())
  const AUG28 = new Date(Date.UTC(2026, 7, 28, 0, 30, 0))
  const pastDue = (over: Record<string, unknown> = {}) => ({
    planId: 'starter', status: 'past_due', currentPeriodStart: '2026-08-28', currentPeriodEnd: '2026-09-27',
    anchorDay: 28, autoRenew: true, payuniCardToken: 'HASH1', ...over,
  })

  it('訂單方案 = 排程的新方案 → 開通新方案並清掉排程（否則下期會再降一次）', async () => {
    const db = makeDb({
      'paymentOrders/R1': pendingOrder({ merchantOrderNo: 'R1', kind: 'period_recurring', planId: 'lite', amount: 399 }),
      'workspaces/ws1': { subscription: pastDue({ pendingPlanId: 'lite' }) },
    }) as any
    await settlePaidOrder({ merchantOrderNo: 'R1', paid: true, amount: 399, now: AUG28 }, db)

    const sub = db._store.get('workspaces/ws1').subscription
    expect(sub.planId).toBe('lite')
    expect(sub.status).toBe('active')
    expect(sub.pendingPlanId).toBeUndefined()
    expect(sub.currentPeriodStart).toBe('2026-08-28') // 仍是同一期
  })

  it('折抵：以**訂單上的 creditApplied** 扣餘額（重試/查單補查不會重複扣）', async () => {
    const db = makeDb({
      'paymentOrders/R1': pendingOrder({ merchantOrderNo: 'R1', kind: 'period_recurring', planId: 'starter', amount: 699, creditApplied: 100 }),
      'workspaces/ws1': { subscription: pastDue({ creditBalance: 300 }) },
    }) as any
    await settlePaidOrder({ merchantOrderNo: 'R1', paid: true, amount: 699, now: AUG28 }, db)

    expect(db._store.get('workspaces/ws1').subscription.creditBalance).toBe(200)
  })

  it('折抵用完 → 欄位清掉,不留 0（避免畫面顯示「折抵餘額 NT$0」）', async () => {
    const db = makeDb({
      'paymentOrders/R1': pendingOrder({ merchantOrderNo: 'R1', kind: 'period_recurring', planId: 'starter', amount: 699, creditApplied: 100 }),
      'workspaces/ws1': { subscription: pastDue({ creditBalance: 100 }) },
    }) as any
    await settlePaidOrder({ merchantOrderNo: 'R1', paid: true, amount: 699, now: AUG28 }, db)

    expect(db._store.get('workspaces/ws1').subscription.creditBalance).toBeUndefined()
  })

  it('立即換方案（升級）→ 折抵餘額**必須跟著過來**,排程的期末降級則被這次購買取代', async () => {
    const db = makeDb({
      'paymentOrders/NP1': pendingOrder({ planId: 'growth', amount: 1499, kind: 'one_time' }),
      'workspaces/ws1': { subscription: pastDue({ pendingPlanId: 'lite', creditBalance: 300 }) },
    }) as any
    await settlePaidOrder({ merchantOrderNo: 'NP1', paid: true, amount: 1499, now: AUG28 }, db)

    const sub = db._store.get('workspaces/ws1').subscription
    expect(sub.planId).toBe('growth')
    // 折抵是客戶的錢:重建訂閱時漏帶就等於我們把欠他的折抵刪掉
    expect(sub.creditBalance).toBe(300)
    // pendingPlanId 刻意不帶:客戶剛主動換了方案,期末不該再把它降回舊的排程
    expect(sub.pendingPlanId).toBeUndefined()
  })
})

describe('buildPaidSubscription — past_due 不堆疊（換卡/補繳）', () => {
  it('past_due（本期還沒收到錢）→ 從今天重新起算,不接在到期日之後', () => {
    // 8/28 開始的一期沒扣到款 → roll 把它標 past_due。客戶 8/28 換卡補繳:
    // 若堆疊,他會拿到 9/28~10/27 這段未來期間,而沒付款的本期照樣在寬限期滿被降級。
    const pastDue: WorkspaceSubscription = {
      planId: 'lite', status: 'past_due',
      currentPeriodStart: '2026-08-28', currentPeriodEnd: '2026-09-27', anchorDay: 28,
      autoRenew: true, payuniCardToken: 'OLD',
    }
    const sub = buildPaidSubscription('lite', new Date(Date.UTC(2026, 7, 28, 0, 30)), pastDue, {
      payuniCard: { token: 'NEW', last4: '5678', expiry: '0930' },
    })
    expect(sub.currentPeriodStart).toBe('2026-08-28') // 今天,不是 9/28
    expect(sub.currentPeriodEnd).toBe('2026-09-27')
    expect(sub.status).toBe('active')
    expect(sub.payuniCardToken).toBe('NEW') // 換卡:新 Token 覆蓋舊的
    expect(sub.payuniCardLast4).toBe('5678')
  })

  it('active 且未到期 → 仍然堆疊（提前換卡/續費不白付）', () => {
    const active: WorkspaceSubscription = {
      planId: 'lite', status: 'active',
      currentPeriodStart: '2026-08-28', currentPeriodEnd: '2026-09-27', anchorDay: 28,
      autoRenew: true, payuniCardToken: 'OLD',
    }
    const sub = buildPaidSubscription('lite', new Date(Date.UTC(2026, 8, 1, 0, 30)), active, {
      payuniCard: { token: 'NEW', last4: '5678', expiry: null },
    })
    expect(sub.currentPeriodStart).toBe('2026-09-28') // 接在 9/27 之後
    expect(sub.payuniCardToken).toBe('NEW')
  })
})

describe('settlePaidOrder — 換卡會回報被取代的舊 Token（否則舊約定永遠解不掉）', () => {
  beforeEach(() => invalidateWorkspaceSubscriptionCache())
  const AUG28 = new Date(Date.UTC(2026, 7, 28, 0, 30, 0))

  it('新 Token 覆蓋舊 Token → 回報 replacedCardToken 給呼叫端去解約', async () => {
    const db = makeDb({
      'paymentOrders/NP9': pendingOrder({ merchantOrderNo: 'NP9', kind: 'period_first', planId: 'lite', amount: 399 }),
      'workspaces/ws1': { subscription: {
        planId: 'lite', status: 'active', currentPeriodStart: '2026-08-01', currentPeriodEnd: '2026-08-31',
        anchorDay: 1, autoRenew: true, payuniCardToken: 'OLD_HASH', payuniCardLast4: '1111',
      } },
    }) as any
    const r = await settlePaidOrder({
      merchantOrderNo: 'NP9', paid: true, amount: 399,
      payuniCard: { token: 'NEW_HASH', last4: '2222', expiry: '0930' }, now: AUG28,
    }, db)

    expect(r.replacedCardToken).toBe('OLD_HASH')
    expect(db._store.get('workspaces/ws1').subscription.payuniCardToken).toBe('NEW_HASH')
  })

  it('Token 沒變（沿用同一組）→ 不回報,免得對還在用的約定發解約', async () => {
    const db = makeDb({
      'paymentOrders/NP9': pendingOrder({ merchantOrderNo: 'NP9', kind: 'period_first', planId: 'lite', amount: 399 }),
      'workspaces/ws1': { subscription: {
        planId: 'lite', status: 'active', currentPeriodStart: '2026-08-01', currentPeriodEnd: '2026-08-31',
        anchorDay: 1, autoRenew: true, payuniCardToken: 'SAME_HASH',
      } },
    }) as any
    const r = await settlePaidOrder({
      merchantOrderNo: 'NP9', paid: true, amount: 399,
      payuniCard: { token: 'SAME_HASH', last4: null, expiry: null }, now: AUG28,
    }, db)

    expect(r.replacedCardToken).toBeNull()
  })

  it('本來沒有 Token（第一次訂閱）→ 不回報', async () => {
    const db = makeDb({ 'paymentOrders/NP9': pendingOrder({ merchantOrderNo: 'NP9', kind: 'period_first', planId: 'lite', amount: 399 }) }) as any
    const r = await settlePaidOrder({
      merchantOrderNo: 'NP9', paid: true, amount: 399,
      payuniCard: { token: 'NEW_HASH', last4: null, expiry: null }, now: AUG28,
    }, db)
    expect(r.replacedCardToken).toBeNull()
  })
})
