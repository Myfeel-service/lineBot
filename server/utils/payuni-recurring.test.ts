import { beforeEach, describe, expect, it, vi } from 'vitest'

// 把「會打網路 / 會寄信 / 會開發票」的三個相鄰模組換成假的：
// 本檔要驗的是**排程決策**（誰該扣、扣幾次、失敗怎麼辦、UNKNOWN 怎麼辦），
// 扣款封包本身與開通路徑各自已有測試（payuni.test.ts / payment.test.ts）。
vi.mock('./payuni', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./payuni')>()
  return { ...actual, chargeCreditToken: vi.fn() }
})
vi.mock('./payuni-fulfill', () => ({ fulfillPayuniTrade: vi.fn() }))
vi.mock('./billing-emails', () => ({ sendChargeFailedNotification: vi.fn(), sendReceiptNotification: vi.fn() }))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))

import { chargeCreditToken } from './payuni'
import { fulfillPayuniTrade } from './payuni-fulfill'
import { sendChargeFailedNotification, sendReceiptNotification } from './billing-emails'
import { chargeDueRecurring, isDueForRecurringCharge, recurringOrderNo } from './payuni-recurring'
import { INVOICE_ORDER_NO_MAX } from './payment'
import type { WorkspaceSubscription } from '~~/shared/billing/plans'

const mockCharge = vi.mocked(chargeCreditToken)
const mockFulfill = vi.mocked(fulfillPayuniTrade)
const mockFailMail = vi.mocked(sendChargeFailedNotification)
const mockReceipt = vi.mocked(sendReceiptNotification)

// 2026-08-28（UTC 00:30 = 台灣 08:30）：8/27 到期的訂閱昨天已被 roll 推進新一期
const AUG28 = new Date(Date.UTC(2026, 7, 28, 0, 30, 0))
const TODAY = '2026-08-28'

const CONFIG = {
  payuniPeriodEnabled: true,
  payuniMerchantId: 'S076820628',
  payuniHashKey: 'abcdefghijklmnopqrstuvwxyz123456',
  payuniHashIV: '1234567890abcdef',
  payuniEnv: 'test',
  public: { brandName: 'MiniMe' },
}

/** 已被 roll 推進新一期、等扣款的自動續訂（= 該被續扣的樣子）。 */
function dueSub(over: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription {
  return {
    planId: 'lite',
    status: 'past_due',
    currentPeriodStart: '2026-08-28',
    currentPeriodEnd: '2026-09-27',
    anchorDay: 28,
    autoRenew: true,
    payuniCardToken: 'HASH1',
    payuniCardLast4: '1234',
    ...over,
  }
}

/**
 * 真 Firestore 的 `update()` 會把 `'a.b'` 當成**巢狀欄位路徑**（只改 a.b,不動 a 的其他 key），
 * FieldValue.delete() 則是刪掉那個欄位。程式碼刻意靠這個語意避免「整包覆寫」,
 * 所以 mock 必須照著做——否則測不到真正的行為。
 */
function applyUpdate(target: any, data: Record<string, any>): any {
  const out = { ...(target ?? {}) }
  for (const [key, value] of Object.entries(data)) {
    const isDelete = typeof value === 'object' && value !== null
      && /delete/i.test(String((value as any).methodName ?? (value as any)._methodName ?? ''))
    const parts = key.split('.')
    if (parts.length === 1) {
      if (isDelete) delete out[key]
      else out[key] = value
      continue
    }
    let node = out
    for (const p of parts.slice(0, -1)) {
      node[p] = { ...(node[p] ?? {}) }
      node = node[p]
    }
    const leaf = parts[parts.length - 1]!
    if (isDelete) delete node[leaf]
    else node[leaf] = value
  }
  return out
}

// ── 極簡 in-memory Firestore：支援 where().get()、doc().get()/create()、runTransaction ──
function makeDb(initial: Record<string, unknown> = {}) {
  const store = new Map<string, any>(Object.entries(initial))
  const docRef = (collection: string, id: string) => ({
    _key: `${collection}/${id}`,
    id,
    async get() {
      const d = store.get(`${collection}/${id}`)
      return { exists: d !== undefined, id, data: () => d }
    },
    async create(data: any) {
      const k = `${collection}/${id}`
      if (store.has(k)) { const e: any = new Error('ALREADY_EXISTS'); e.code = 6; throw e }
      store.set(k, data)
    },
    async update(data: any) {
      const k = `${collection}/${id}`
      store.set(k, applyUpdate(store.get(k), data))
    },
  })
  return {
    _store: store,
    collection: (c: string) => {
      // where() 要能鏈接（hasUnresolvedRecurringOrder 用兩個等值條件）
      const query = (filters: Array<[string, unknown]>): any => ({
        where: (field: string, _op: string, value: unknown) => query([...filters, [field, value]]),
        async get() {
          const docs = [...store.entries()]
            .filter(([k]) => k.startsWith(`${c}/`))
            .filter(([, v]) => filters.every(([f, val]) => f.split('.').reduce<any>((o, p) => o?.[p], v) === val))
            .map(([k, v]) => ({ id: k.slice(c.length + 1), data: () => v, ref: docRef(c, k.slice(c.length + 1)) }))
          return { docs, empty: docs.length === 0 }
        },
      })
      return { doc: (id: string) => docRef(c, id), where: query([]).where }
    },
    async runTransaction(fn: (tx: any) => any) {
      const tx = {
        get: (ref: any) => ref.get(),
        update: (ref: any, data: any) => store.set(ref._key, applyUpdate(store.get(ref._key), data)),
        create: (ref: any, data: any) => store.set(ref._key, data),
        set: (ref: any, data: any) => store.set(ref._key, data),
      }
      return fn(tx)
    },
  }
}

beforeEach(() => {
  mockCharge.mockReset()
  mockFulfill.mockReset()
  mockFailMail.mockReset()
  mockReceipt.mockReset()
})

describe('recurringOrderNo（續扣單號 = 冪等鍵）', () => {
  it('19 碼純大寫英數,且 ≤ 發票自訂編號上限（超過的話續期發票會全被退件）', () => {
    const no = recurringOrderNo('ws1', '2026-08-28', '2026-08-28')
    expect(no).toHaveLength(19)
    expect(no).toMatch(/^R[0-9A-Z]+$/)
    expect(no.length).toBeLessThanOrEqual(INVOICE_ORDER_NO_MAX)
  })

  it('同帳號 + 同期 + 同天 → 同一個單號（重跑會撞 create,擋掉重複扣款）', () => {
    expect(recurringOrderNo('ws1', '2026-08-28', '2026-08-28'))
      .toBe(recurringOrderNo('ws1', '2026-08-28', '2026-08-28'))
  })

  it('隔天重試 → 不同單號（PAYUNi 要求 MerTradeNo 10 分鐘內不得重複）', () => {
    expect(recurringOrderNo('ws1', '2026-08-28', '2026-08-29'))
      .not.toBe(recurringOrderNo('ws1', '2026-08-28', '2026-08-28'))
  })

  it('不同帳號 / 不同期 → 不同單號', () => {
    const a = recurringOrderNo('ws1', '2026-08-28', '2026-08-28')
    expect(recurringOrderNo('ws2', '2026-08-28', '2026-08-28')).not.toBe(a)
    expect(recurringOrderNo('ws1', '2026-09-28', '2026-08-28')).not.toBe(a)
  })
})

describe('isDueForRecurringCharge（誰該被扣）', () => {
  it('roll 已推進新一期的 past_due 自動續訂 → 該扣', () => {
    expect(isDueForRecurringCharge(dueSub(), TODAY)).toBe(true)
  })

  it('active（本期已付）→ 不扣', () => {
    expect(isDueForRecurringCharge(dueSub({ status: 'active' }), TODAY)).toBe(false)
  })

  it('已按取消 → 不扣（取消是期末生效,不能再扣下一期）', () => {
    expect(isDueForRecurringCharge(dueSub({ cancelAtPeriodEnd: true }), TODAY)).toBe(false)
  })

  it('沒有自動續訂 → 不扣', () => {
    expect(isDueForRecurringCharge(dueSub({ autoRenew: false }), TODAY)).toBe(false)
    expect(isDueForRecurringCharge(dueSub({ autoRenew: undefined }), TODAY)).toBe(false)
  })

  it('沒有約定卡 Token → 不扣（扣不了；首刷沒建成約定的人就是這種）', () => {
    expect(isDueForRecurringCharge(dueSub({ payuniCardToken: undefined }), TODAY)).toBe(false)
  })

  it('免費 / 企業 / 內部方案 → 不扣（沒月費或走合約,不該被程式自動刷卡）', () => {
    for (const planId of ['free', 'enterprise', 'test', 'internal'] as const) {
      expect(isDueForRecurringCharge(dueSub({ planId }), TODAY)).toBe(false)
    }
  })

  it('今天已經試過 → 不扣（每日只重試一次,不打爆客戶的卡）', () => {
    expect(isDueForRecurringCharge(dueSub({ lastChargeDate: TODAY }), TODAY)).toBe(false)
    expect(isDueForRecurringCharge(dueSub({ lastChargeDate: '2026-08-27' }), TODAY)).toBe(true)
  })

  it('null / undefined 不炸', () => {
    expect(isDueForRecurringCharge(null, TODAY)).toBe(false)
    expect(isDueForRecurringCharge(undefined, TODAY)).toBe(false)
  })
})

describe('chargeDueRecurring', () => {
  it('旗標未開 → 完全不動作（零副作用）', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub() } }) as any
    const r = await chargeDueRecurring({ ...CONFIG, payuniPeriodEnabled: false }, AUG28, db)
    expect(r).toEqual({ due: 0, charged: 0, covered: 0, failed: 0, unknown: 0, skipped: 0 })
    expect(mockCharge).not.toHaveBeenCalled()
  })

  it('金流金鑰未設 → 不動作', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub() } }) as any
    const r = await chargeDueRecurring({ ...CONFIG, payuniHashKey: '' }, AUG28, db)
    expect(r.due).toBe(0)
    expect(mockCharge).not.toHaveBeenCalled()
  })

  it('扣款成功 → 建本期帳、用 Token 扣正確金額、走共用開通路徑', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub() } }) as any
    mockCharge.mockResolvedValue({ ok: true, outerStatus: 'SUCCESS', result: { TradeStatus: '1', TradeAmt: '399' } })
    mockFulfill.mockResolvedValue({ merchantOrderNo: 'R', paid: true, outcome: 'settled' })

    const r = await chargeDueRecurring(CONFIG, AUG28, db)

    expect(r).toMatchObject({ due: 1, charged: 1, failed: 0, unknown: 0 })
    // 金額由方案表決定（lite=399），Token 用訂閱上存的那組
    expect(mockCharge).toHaveBeenCalledTimes(1)
    expect(mockCharge.mock.calls[0]![0]).toMatchObject({ tradeAmt: 399, creditHash: 'HASH1' })
    // 帳本：kind=period_recurring、金額一致、doc id = 冪等鍵
    const orderNo = recurringOrderNo('ws1', '2026-08-28', TODAY)
    expect(db._store.get(`paymentOrders/${orderNo}`)).toMatchObject({
      workspaceId: 'ws1', planId: 'lite', amount: 399, kind: 'period_recurring', status: 'pending',
    })
    // 開通/開發票/收據一律交給與 Notify 相同的那條路
    expect(mockFulfill).toHaveBeenCalledTimes(1)
    expect(mockFulfill.mock.calls[0]![1]).toMatchObject({ MerTradeNo: orderNo })
  })

  it('claim 會寫下 lastChargeDate + 本期嘗試次數（同一天第二次跑就不會再扣）', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub() } }) as any
    mockCharge.mockResolvedValue({ ok: false, outerStatus: 'CREDIT02011', result: { TradeStatus: '2', Message: '卡片授權失敗' } })
    mockFulfill.mockResolvedValue({ merchantOrderNo: 'R', paid: false, outcome: 'settled' })

    await chargeDueRecurring(CONFIG, AUG28, db)
    const sub1 = db._store.get('workspaces/ws1').subscription
    expect(sub1.lastChargeDate).toBe(TODAY)
    expect(sub1.chargeAttempts).toBe(1)
    expect(sub1.chargePeriodStart).toBe('2026-08-28')

    // 同一天再跑一輪 → 完全不再扣款
    mockCharge.mockClear()
    const r2 = await chargeDueRecurring(CONFIG, AUG28, db)
    expect(r2.due).toBe(0)
    expect(mockCharge).not.toHaveBeenCalled()
  })

  it('扣款失敗 → 維持 past_due（服務照跑）、記下原因、寄一次失敗提醒', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub() } }) as any
    mockCharge.mockResolvedValue({ ok: false, outerStatus: 'CREDIT02011', result: { TradeStatus: '2', Message: '卡片授權失敗' } })
    mockFulfill.mockResolvedValue({ merchantOrderNo: 'R', paid: false, outcome: 'settled' })

    const r = await chargeDueRecurring(CONFIG, AUG28, db)

    expect(r).toMatchObject({ due: 1, charged: 0, failed: 1 })
    const sub = db._store.get('workspaces/ws1').subscription
    expect(sub.status).toBe('past_due') // 降級一律交給 roll,不在這裡動方案
    expect(sub.planId).toBe('lite')
    expect(sub.lastChargeError).toBe('卡片授權失敗')
    expect(mockFailMail).toHaveBeenCalledTimes(1)
  })

  it('隔天重試（第 2 次失敗）→ 不再重複寄提醒信', async () => {
    const db = makeDb({
      'workspaces/ws1': { subscription: dueSub({ lastChargeDate: '2026-08-27', chargeAttempts: 1, chargePeriodStart: '2026-08-28' }) },
    }) as any
    mockCharge.mockResolvedValue({ ok: false, outerStatus: 'CREDIT02011', result: { TradeStatus: '2', Message: '卡片授權失敗' } })
    mockFulfill.mockResolvedValue({ merchantOrderNo: 'R', paid: false, outcome: 'settled' })

    await chargeDueRecurring(CONFIG, AUG28, db)

    expect(db._store.get('workspaces/ws1').subscription.chargeAttempts).toBe(2)
    expect(mockFailMail).not.toHaveBeenCalled()
  })

  it('換到新一期 → 嘗試次數歸零（不繼承上一期的失敗計數）', async () => {
    const db = makeDb({
      'workspaces/ws1': { subscription: dueSub({ lastChargeDate: '2026-07-30', chargeAttempts: 3, chargePeriodStart: '2026-07-28' }) },
    }) as any
    mockCharge.mockResolvedValue({ ok: true, outerStatus: 'SUCCESS', result: { TradeStatus: '1' } })
    mockFulfill.mockResolvedValue({ merchantOrderNo: 'R', paid: true, outcome: 'settled' })

    await chargeDueRecurring(CONFIG, AUG28, db)
    expect(db._store.get('workspaces/ws1').subscription.chargeAttempts).toBe(1)
  })

  it('PAYUNi 回 UNKNOWN → **不當失敗**、不重扣,訂單留 pending 給查單補救', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub() } }) as any
    mockCharge.mockResolvedValue({ ok: false, outerStatus: 'UNKNOWN', result: null })

    const r = await chargeDueRecurring(CONFIG, AUG28, db)

    expect(r).toMatchObject({ due: 1, charged: 0, failed: 0, unknown: 1 })
    expect(mockFulfill).not.toHaveBeenCalled() // 不能標失敗（銀行可能其實已經授權）
    expect(mockFailMail).not.toHaveBeenCalled()
    const orderNo = recurringOrderNo('ws1', '2026-08-28', TODAY)
    expect(db._store.get(`paymentOrders/${orderNo}`).status).toBe('pending')
  })

  it('扣款呼叫本身丟錯（網路斷）→ 同 UNKNOWN 處理,絕不重扣', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub() } }) as any
    mockCharge.mockRejectedValue(new Error('ECONNRESET'))

    const r = await chargeDueRecurring(CONFIG, AUG28, db)
    expect(r).toMatchObject({ unknown: 1, failed: 0, charged: 0 })
    expect(mockFulfill).not.toHaveBeenCalled()
  })

  it('本期這天的帳已存在（重跑/碰撞）→ 跳過,不扣款', async () => {
    const orderNo = recurringOrderNo('ws1', '2026-08-28', TODAY)
    const db = makeDb({
      'workspaces/ws1': { subscription: dueSub() },
      [`paymentOrders/${orderNo}`]: { merchantOrderNo: orderNo, status: 'paid' },
    }) as any
    mockCharge.mockResolvedValue({ ok: true, outerStatus: 'SUCCESS', result: { TradeStatus: '1' } })

    const r = await chargeDueRecurring(CONFIG, AUG28, db)
    expect(r).toMatchObject({ due: 1, skipped: 1, charged: 0 })
    expect(mockCharge).not.toHaveBeenCalled()
  })

  it('只挑該扣的:同一批 past_due 裡的取消者/無 Token/免費層都不會被扣', async () => {
    const db = makeDb({
      'workspaces/ok': { subscription: dueSub() },
      'workspaces/canceled': { subscription: dueSub({ cancelAtPeriodEnd: true }) },
      'workspaces/notoken': { subscription: dueSub({ payuniCardToken: undefined }) },
      'workspaces/free': { subscription: dueSub({ planId: 'free' }) },
      'workspaces/activeone': { subscription: dueSub({ status: 'active' }) },
    }) as any
    mockCharge.mockResolvedValue({ ok: true, outerStatus: 'SUCCESS', result: { TradeStatus: '1' } })
    mockFulfill.mockResolvedValue({ merchantOrderNo: 'R', paid: true, outcome: 'settled' })

    const r = await chargeDueRecurring(CONFIG, AUG28, db)
    expect(r).toMatchObject({ due: 1, charged: 1 })
    expect(mockCharge).toHaveBeenCalledTimes(1)
  })
})

describe('chargeDueRecurring — P4 降級期末生效 / 折抵', () => {
  it('有降級排程 → 建單用**新方案**與新價格,扣款也是新價格', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub({ planId: 'starter', pendingPlanId: 'lite' }) } }) as any
    mockCharge.mockResolvedValue({ ok: true, outerStatus: 'SUCCESS', result: { TradeStatus: '1' } })
    mockFulfill.mockResolvedValue({ merchantOrderNo: 'R', paid: true, outcome: 'settled' })

    await chargeDueRecurring(CONFIG, AUG28, db)

    expect(mockCharge.mock.calls[0]![0]).toMatchObject({ tradeAmt: 399 }) // lite,不是 starter 的 799
    const orderNo = recurringOrderNo('ws1', '2026-08-28', TODAY)
    expect(db._store.get(`paymentOrders/${orderNo}`)).toMatchObject({ planId: 'lite', amount: 399 })
  })

  it('部分折抵 → 只扣差額,並把用掉的折抵記在訂單上（重試/補查不會重複扣餘額）', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub({ creditBalance: 100 }) } }) as any
    mockCharge.mockResolvedValue({ ok: true, outerStatus: 'SUCCESS', result: { TradeStatus: '1' } })
    mockFulfill.mockResolvedValue({ merchantOrderNo: 'R', paid: true, outcome: 'settled' })

    await chargeDueRecurring(CONFIG, AUG28, db)

    expect(mockCharge.mock.calls[0]![0]).toMatchObject({ tradeAmt: 299 }) // 399 − 100
    const orderNo = recurringOrderNo('ws1', '2026-08-28', TODAY)
    expect(db._store.get(`paymentOrders/${orderNo}`)).toMatchObject({ amount: 299, creditApplied: 100 })
  })

  it('折抵蓋滿整期 → **完全不呼叫金流**（0 元請款會被退）,直接續期且不開發票', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub({ creditBalance: 1000 }) } }) as any

    const r = await chargeDueRecurring(CONFIG, AUG28, db)

    expect(r).toMatchObject({ due: 1, covered: 1, charged: 0, failed: 0 })
    expect(mockCharge).not.toHaveBeenCalled()
    expect(mockFulfill).not.toHaveBeenCalled() // 不走開發票那條路
    const orderNo = recurringOrderNo('ws1', '2026-08-28', TODAY)
    const order = db._store.get(`paymentOrders/${orderNo}`)
    expect(order).toMatchObject({ amount: 0, creditApplied: 399, status: 'paid', invoiceStatus: 'skipped', paymentType: 'CREDIT_BALANCE' })
    // 訂閱續期成功、餘額扣掉這期用掉的 399
    expect(db._store.get('workspaces/ws1').subscription).toMatchObject({
      status: 'active', currentPeriodStart: '2026-08-28', creditBalance: 601,
    })
  })

  it('排程降到免費層 → 不扣款（免費層沒有月費,交給 roll 自然降級）', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub({ pendingPlanId: 'free' }) } }) as any
    const r = await chargeDueRecurring(CONFIG, AUG28, db)
    expect(r.due).toBe(0)
    expect(mockCharge).not.toHaveBeenCalled()
  })
})

// ── code review 修復的迴歸測試（每一條都對應一個會扣錯錢的情境）──────────────

describe('isDueForRecurringCharge — 寬限期與壞資料', () => {
  it('寬限期(3 天)已過 → **不扣**（否則被拒的卡會每天重扣到永遠）', () => {
    // 本期 8/28 起,寬限期到 8/31。9/1 之後這筆該被降級,不是再扣一次。
    expect(isDueForRecurringCharge(dueSub(), '2026-08-31')).toBe(true)
    expect(isDueForRecurringCharge(dueSub(), '2026-09-01')).toBe(false)
    expect(isDueForRecurringCharge(dueSub(), '2026-10-15')).toBe(false)
  })

  it('沒有 currentPeriodStart（壞資料）→ 不扣,也不會炸掉單號產生器', () => {
    expect(isDueForRecurringCharge(dueSub({ currentPeriodStart: null }), TODAY)).toBe(false)
  })
})

describe('chargeDueRecurring — 結果未定的各種形狀都不能當失敗', () => {
  const cases: Array<[string, { ok: boolean, outerStatus: string, result: any }]> = [
    ['UNKNOWN（銀行 60 秒未回）', { ok: false, outerStatus: 'UNKNOWN', result: null }],
    ['TradeStatus=8 待確認（外層還是 SUCCESS）', { ok: false, outerStatus: 'SUCCESS', result: { TradeStatus: '8' } }],
    ['HTTP_504（閘道逾時,授權可能已成立）', { ok: false, outerStatus: 'HTTP_504', result: null }],
    ['BAD_JSON（連回應都讀不到）', { ok: false, outerStatus: 'BAD_JSON', result: null }],
  ]
  for (const [label, authz] of cases) {
    it(`${label} → 留 pending 待查,不標失敗、不寄失敗信`, async () => {
      const db = makeDb({ 'workspaces/ws1': { subscription: dueSub() } }) as any
      mockCharge.mockResolvedValue(authz as any)

      const r = await chargeDueRecurring(CONFIG, AUG28, db)

      expect(r).toMatchObject({ due: 1, unknown: 1, failed: 0, charged: 0 })
      // 關鍵:不能走 fulfill → 那會把訂單寫成 failed（終態）,銀行事後核准就再也結算不了
      expect(mockFulfill).not.toHaveBeenCalled()
      expect(mockFailMail).not.toHaveBeenCalled()
      const orderNo = recurringOrderNo('ws1', '2026-08-28', TODAY)
      expect(db._store.get(`paymentOrders/${orderNo}`).status).toBe('pending')
    })
  }
})

describe('chargeDueRecurring — 韌性', () => {
  it('還有未決的續扣單 → 本輪不扣（避免同一期兩筆授權都成立）', async () => {
    const db = makeDb({
      'workspaces/ws1': { subscription: dueSub({ lastChargeDate: '2026-08-27' }) },
      // 昨天那筆還在 pending = 結果未定
      'paymentOrders/ROLD': { merchantOrderNo: 'ROLD', workspaceId: 'ws1', status: 'pending', kind: 'period_recurring' },
    }) as any
    mockCharge.mockResolvedValue({ ok: true, outerStatus: 'SUCCESS', result: { TradeStatus: '1' } })

    const r = await chargeDueRecurring(CONFIG, AUG28, db)
    expect(r).toMatchObject({ due: 1, skipped: 1, charged: 0 })
    expect(mockCharge).not.toHaveBeenCalled()
  })

  it('未決的是**單次付款**單 → 不擋續扣（客戶自己開著一個付款頁不該卡住排程）', async () => {
    const db = makeDb({
      'workspaces/ws1': { subscription: dueSub() },
      'paymentOrders/NP1': { merchantOrderNo: 'NP1', workspaceId: 'ws1', status: 'pending', kind: 'one_time' },
    }) as any
    mockCharge.mockResolvedValue({ ok: true, outerStatus: 'SUCCESS', result: { TradeStatus: '1' } })
    mockFulfill.mockResolvedValue({ merchantOrderNo: 'R', paid: true, outcome: 'settled' })

    expect((await chargeDueRecurring(CONFIG, AUG28, db)).charged).toBe(1)
  })

  it('金鑰長度設錯 → **整輪中止**,不燒掉任何人的當日扣款機會', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub() } }) as any
    // IV 少一碼:若沒有先驗,會在每個帳號的扣款呼叫裡才 throw、被誤歸成「結果未定」,
    // 而 claim 已經把當天唯一一次嘗試燒掉 → 3 天後所有付費客戶靜默降級。
    const r = await chargeDueRecurring({ ...CONFIG, payuniHashIV: '123456789012345' }, AUG28, db)

    expect(r).toEqual({ due: 0, charged: 0, covered: 0, failed: 0, unknown: 0, skipped: 0 })
    expect(mockCharge).not.toHaveBeenCalled()
    // 沒有被 claim → lastChargeDate 不該被寫進去
    expect(db._store.get('workspaces/ws1').subscription.lastChargeDate).toBeUndefined()
  })

  it('單筆流程異常 → 跳過那一筆繼續跑,不讓整輪對帳掛掉', async () => {
    const db = makeDb({
      'workspaces/bad': { subscription: dueSub() },
      'workspaces/good': { subscription: dueSub() },
    }) as any
    mockCharge
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'Error' }))
      .mockResolvedValue({ ok: true, outerStatus: 'SUCCESS', result: { TradeStatus: '1' } })
    mockFulfill.mockResolvedValue({ merchantOrderNo: 'R', paid: true, outcome: 'settled' })

    const r = await chargeDueRecurring(CONFIG, AUG28, db)
    // 一筆未定（fetch throw）+ 一筆成功 —— 整輪沒有 reject
    expect(r.due).toBe(2)
    expect(r.charged + r.unknown).toBe(2)
  })

  it('recordChargeError 只改 lastChargeError,不會覆寫同時間寫入的取消狀態', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub() } }) as any
    mockCharge.mockResolvedValue({ ok: false, outerStatus: 'CREDIT02011', result: { TradeStatus: '2', Message: '卡片授權失敗' } })
    mockFulfill.mockImplementation(async () => {
      // 模擬「扣款失敗後、寫回原因前」客戶按了取消訂閱（另一支端點的點狀寫入）
      const cur = db._store.get('workspaces/ws1')
      db._store.set('workspaces/ws1', { ...cur, subscription: { ...cur.subscription, autoRenew: false, cancelAtPeriodEnd: true } })
      return { merchantOrderNo: 'R', paid: false, outcome: 'settled' as const }
    })

    await chargeDueRecurring(CONFIG, AUG28, db)

    const sub = db._store.get('workspaces/ws1').subscription
    expect(sub.lastChargeError).toBe('卡片授權失敗')
    expect(sub.autoRenew).toBe(false) // ← 客戶的取消沒有被還原
    expect(sub.cancelAtPeriodEnd).toBe(true)
  })
})

describe('chargeDueRecurring — 折抵全額支付也要通知客戶', () => {
  it('折抵蓋滿整期 → 仍寄收據（否則這期對客戶完全靜默,他會以為訂閱斷了）', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub({ creditBalance: 1000 }) } }) as any
    const r = await chargeDueRecurring(CONFIG, AUG28, db)

    expect(r.covered).toBe(1)
    expect(mockCharge).not.toHaveBeenCalled()   // 沒有信用卡交易
    expect(mockFulfill).not.toHaveBeenCalled()  // 不走開發票那條路
    // 但客戶要收到通知——單號要對得上這期的帳
    expect(mockReceipt).toHaveBeenCalledTimes(1)
    expect(mockReceipt).toHaveBeenCalledWith(recurringOrderNo('ws1', '2026-08-28', TODAY))
  })

  it('部分折抵（有真的扣款）→ 收據由 fulfillPayuniTrade 那條路寄,不重複寄', async () => {
    const db = makeDb({ 'workspaces/ws1': { subscription: dueSub({ creditBalance: 100 }) } }) as any
    mockCharge.mockResolvedValue({ ok: true, outerStatus: 'SUCCESS', result: { TradeStatus: '1' } })
    mockFulfill.mockResolvedValue({ merchantOrderNo: 'R', paid: true, outcome: 'settled' })

    await chargeDueRecurring(CONFIG, AUG28, db)

    expect(mockFulfill).toHaveBeenCalledTimes(1)
    expect(mockReceipt).not.toHaveBeenCalled() // 這條路不自己寄,避免一期兩封
  })
})
