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
vi.mock('./payment', () => ({ getPendingOrders: vi.fn() }))

import { queryCardBinding } from './payuni'
import { fulfillPayuniTrade } from './payuni-fulfill'
import { getPendingOrders } from './payment'
import { reconcilePayuniPending } from './payuni-reconcile'
import type { PaymentOrderDoc } from '~~/shared/types/payment'

const mockBindQuery = vi.mocked(queryCardBinding)
const mockFulfill = vi.mocked(fulfillPayuniTrade)
const mockPending = vi.mocked(getPendingOrders)

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
