import { beforeEach, describe, expect, it, vi } from 'vitest'

// 這一檔只驗「補開通路徑」的決策,不驗封包(payuni.test.ts 有)也不驗開通(payment.test.ts 有):
//   ① trade/query 說已付款才補開通
//   ② **首刷訂單要把約定 Token 補回來**——trade/query 結構上不回 CreditHash,
//      不補就等於「客戶付了首期、期末靜默降級」(2026-08-06 端到端實測踩到)
vi.mock('./payuni', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./payuni')>()
  return { ...actual, queryCardBinding: vi.fn() }
})
vi.mock('./payuni-fulfill', () => ({ fulfillPayuniTrade: vi.fn() }))
vi.mock('./firebase', () => ({ getDb: vi.fn(() => ({})) }))
vi.mock('./payment', () => ({
  getPendingOrders: vi.fn(),
  voidPendingOrder: vi.fn(async () => 'voided'),
  markRecurringNotFoundSeen: vi.fn(),
}))

import { queryCardBinding } from './payuni'
import { fulfillPayuniTrade } from './payuni-fulfill'
import { getPendingOrders, markRecurringNotFoundSeen, voidPendingOrder } from './payment'
import { reconcilePayuniPending } from './payuni-reconcile'
import type { PaymentOrderDoc } from '~~/shared/types/payment'

const mockBindQuery = vi.mocked(queryCardBinding)
const mockFulfill = vi.mocked(fulfillPayuniTrade)
const mockPending = vi.mocked(getPendingOrders)
const mockVoid = vi.mocked(voidPendingOrder)
const mockNotFoundSeen = vi.mocked(markRecurringNotFoundSeen)

const CONFIG = {
  payuniMerchantId: 'S076820628',
  payuniHashKey: 'abcdefghijklmnopqrstuvwxyz123456',
  payuniHashIV: '1234567890abcdef',
  payuniEnv: 'test',
}

function order(over: Partial<PaymentOrderDoc> = {}): PaymentOrderDoc {
  return {
    merchantOrderNo: 'NP2608060001',
    workspaceId: 'ws-1',
    planId: 'lite',
    amount: 399,
    status: 'pending',
    kind: 'period_first',
    ...over,
  } as PaymentOrderDoc
}

/**
 * 假的 trade/query 回應。實測的查單回傳是 PHP 巢狀 `Result[0][X]`,而且**沒有 CreditHash**
 * ——這正是本檔要守住的前提,所以假資料刻意照實測的欄位集合寫。
 */
function queryReply(fields: Record<string, string>) {
  return JSON.stringify({ Status: 'SUCCESS', EncryptInfo: 'enc', HashInfo: 'hash', ...fields })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFulfill.mockResolvedValue({ merchantOrderNo: 'NP2608060001', paid: true, outcome: 'settled' } as never)
  // 預設「這是第一次看到查無」→ 只標記不作廢（要跨兩輪才動手,見 markRecurringNotFoundSeen）
  mockNotFoundSeen.mockImplementation(async (_no, _ws, now) => now.getTime())
  // 攔掉真正的解密:直接回「已付款」的攤平前結構
  vi.stubGlobal('$fetch', vi.fn(async () => queryReply({})))
})

describe('reconcilePayuniPending — 首刷約定補回', () => {
  it('金流未設定 → 完全不動作', async () => {
    const r = await reconcilePayuniPending({}, new Date())
    expect(r).toEqual({ checked: 0, recovered: 0 })
    expect(mockPending).not.toHaveBeenCalled()
  })

  it('period_first 訂單缺 CreditHash → 用 workspaceId 反查並塞回 result', async () => {
    mockPending.mockResolvedValue([order()])
    mockBindQuery.mockResolvedValue({
      ok: true, outerStatus: 'SUCCESS', notFound: false,
      mandate: { token: 'HASH-RECOVERED', last4: '0001', expiry: '1229', status: '1' },
    })
    // 讓解密層回「已付款但沒有 CreditHash」的查單結果
    const payuni = await import('./payuni')
    vi.spyOn(payuni, 'verifyAndDecryptPayuniNotify').mockReturnValue({
      'Result[0][MerTradeNo]': 'NP2608060001',
      'Result[0][TradeStatus]': '1',
      'Result[0][Card4No]': '0001',
    } as never)

    const r = await reconcilePayuniPending(CONFIG, new Date())

    expect(r.recovered).toBe(1)
    // 反查一定要帶我方參照字串(= workspaceId);CreditTokenType 的預設值由 payuni.ts 負責
    expect(mockBindQuery).toHaveBeenCalledWith(
      expect.objectContaining({ creditToken: 'ws-1', merchantId: 'S076820628' }),
      expect.anything(), 'test', undefined,
    )
    // 補回來的 Token 必須進到 fulfill 的 result,下游 parseCardMandate 才吃得到
    expect(mockFulfill).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ CreditHash: 'HASH-RECOVERED', CreditLife: '1229', Card4No: '0001' }),
      CONFIG,
    )
  })

  it('反查不到約定 → 照樣補開通(錢已收,不能不開通),但不會硬塞假 Token', async () => {
    mockPending.mockResolvedValue([order()])
    mockBindQuery.mockResolvedValue({ ok: false, outerStatus: 'QUERY03001', notFound: true, mandate: null })
    const payuni = await import('./payuni')
    vi.spyOn(payuni, 'verifyAndDecryptPayuniNotify').mockReturnValue({
      'Result[0][MerTradeNo]': 'NP2608060001',
      'Result[0][TradeStatus]': '1',
    } as never)

    const r = await reconcilePayuniPending(CONFIG, new Date())

    expect(r.recovered).toBe(1)
    expect(mockFulfill).toHaveBeenCalledWith(true, expect.not.objectContaining({ CreditHash: expect.anything() }), CONFIG)
  })

  it('單次付款(one_time)不去反查約定', async () => {
    mockPending.mockResolvedValue([order({ kind: 'one_time' })])
    const payuni = await import('./payuni')
    vi.spyOn(payuni, 'verifyAndDecryptPayuniNotify').mockReturnValue({
      'Result[0][MerTradeNo]': 'NP2608060001',
      'Result[0][TradeStatus]': '1',
    } as never)

    await reconcilePayuniPending(CONFIG, new Date())

    expect(mockBindQuery).not.toHaveBeenCalled()
  })

  it('trade/query 說未付款 → 不補開通、也不反查', async () => {
    mockPending.mockResolvedValue([order()])
    const payuni = await import('./payuni')
    vi.spyOn(payuni, 'verifyAndDecryptPayuniNotify').mockReturnValue({
      'Result[0][MerTradeNo]': 'NP2608060001',
      'Result[0][TradeStatus]': '9', // 未付款
    } as never)

    const r = await reconcilePayuniPending(CONFIG, new Date())

    expect(r).toEqual({ checked: 1, recovered: 0 })
    expect(mockFulfill).not.toHaveBeenCalled()
    expect(mockBindQuery).not.toHaveBeenCalled()
  })
})

describe('reconcilePayuniPending — PAYUNi 查無此單的續扣單要作廢(但要跨兩輪確認)', () => {
  // 為什麼重要:續扣單卡在 pending 會觸發 chargeDueRecurring 的「仍有未決續扣單就跳過」守衛,
  // 而 pending TTL(3 天)== 寬限期(3 天) → 一次網路抖動就能讓付費客戶「從未被重試」就降級。
  // 反過來也要擋:作廢**可能已授權**的那期 → 下一輪會再刷一次卡,所以要兩輪都查無才動手。
  it('period_recurring + QUERY03001 + 已超過 10 分鐘 + 上一輪就查無 → 作廢,讓下一輪重試', async () => {
    const now = new Date()
    const old = { toMillis: () => now.getTime() - 30 * 60 * 1000 }
    mockPending.mockResolvedValue([order({ kind: 'period_recurring', createdAt: old as never })])
    // 上一輪(20 分鐘前)就看過一次查無
    mockNotFoundSeen.mockResolvedValue(now.getTime() - 20 * 60 * 1000)
    vi.stubGlobal('$fetch', vi.fn(async () => JSON.stringify({ Status: 'QUERY03001', MerID: 'S076820628' })))

    const r = await reconcilePayuniPending(CONFIG, now)

    expect(mockVoid).toHaveBeenCalledWith('NP2608060001', 'ws-1', expect.anything())
    expect(mockFulfill).not.toHaveBeenCalled()
    expect(r).toEqual({ checked: 1, recovered: 0 })
  })

  it('第一次查無只記錄、不作廢 —— 查詢庫延遲或查錯環境時,作廢的會是已授權的那期', async () => {
    const now = new Date()
    const old = { toMillis: () => now.getTime() - 30 * 60 * 1000 }
    mockPending.mockResolvedValue([order({ kind: 'period_recurring', createdAt: old as never })])
    vi.stubGlobal('$fetch', vi.fn(async () => JSON.stringify({ Status: 'QUERY03001' })))

    await reconcilePayuniPending(CONFIG, now)

    expect(mockNotFoundSeen).toHaveBeenCalledWith('NP2608060001', 'ws-1', now, expect.anything())
    expect(mockVoid).not.toHaveBeenCalled()
  })

  it('剛開的單(10 分鐘內)先不作廢 —— PAYUNi 可能只是還沒入庫,那時作廢會誤判', async () => {
    const fresh = { toMillis: () => Date.now() - 60 * 1000 }
    mockPending.mockResolvedValue([order({ kind: 'period_recurring', createdAt: fresh as never })])
    vi.stubGlobal('$fetch', vi.fn(async () => JSON.stringify({ Status: 'QUERY03001' })))

    await reconcilePayuniPending(CONFIG, new Date())

    expect(mockVoid).not.toHaveBeenCalled()
  })

  it('查單與扣款走同一個出口:設了中繼站,trade/query 也要走中繼站', async () => {
    // 為什麼:扣款(/api/credit)走中繼站時,那筆交易到底在正式還是沙盒,取決於**中繼站轉去哪**。
    // 查單若直連 PAYUNi、照 PAYUNI_ENV 選環境,就可能問到另一個環境 → 每筆真的授權成功的
    // 續扣單都回 QUERY03001 → 被判定「沒送達」作廢 → 下一輪重複扣客戶的卡。
    mockPending.mockResolvedValue([order()])
    const fetchSpy = vi.fn(async () => queryReply({}))
    vi.stubGlobal('$fetch', fetchSpy)

    await reconcilePayuniPending({ ...CONFIG, payuniRelayBase: 'https://relay.example.com' }, new Date())

    expect(fetchSpy).toHaveBeenCalledWith('https://relay.example.com/api/trade/query', expect.anything())
  })

  it('沒設中繼站 → 照 PAYUNI_ENV 直連 PAYUNi(現行行為不變)', async () => {
    mockPending.mockResolvedValue([order()])
    const fetchSpy = vi.fn(async () => queryReply({}))
    vi.stubGlobal('$fetch', fetchSpy)

    await reconcilePayuniPending(CONFIG, new Date())

    expect(fetchSpy).toHaveBeenCalledWith('https://sandbox-api.payuni.com.tw/api/trade/query', expect.anything())
  })

  it('首刷單(one_time / period_first)查無此單**不**作廢 —— 客人可能只是還沒付', async () => {
    const old = { toMillis: () => Date.now() - 60 * 60 * 1000 }
    mockPending.mockResolvedValue([order({ kind: 'period_first', createdAt: old as never })])
    vi.stubGlobal('$fetch', vi.fn(async () => JSON.stringify({ Status: 'QUERY03001' })))

    await reconcilePayuniPending(CONFIG, new Date())

    expect(mockVoid).not.toHaveBeenCalled()
  })
})
