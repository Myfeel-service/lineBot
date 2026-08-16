import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Firestore } from 'firebase-admin/firestore'

// 不打真的光貿:stub 開立一律成功,測的是「哪些訂單會被撈去補開」的挑選規則
vi.mock('./guangmao-invoice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./guangmao-invoice')>()
  return {
    ...actual,
    issueInvoice: vi.fn(async () => ({
      ok: true,
      status: '0',
      message: '',
      invoiceNumber: 'ZA10000001',
      randomNum: '1234',
      buyerIdentifier: '0000000000',
      buyerName: '測試帳號',
    })),
  }
})
vi.mock('./firebase', () => ({ getDb: vi.fn(() => ({})) }))

import { issueInvoice } from './guangmao-invoice'
import { issueSkippedInvoices } from './invoice'

const mockIssue = vi.mocked(issueInvoice)

const KEYS = { sellerUBN: '12345678', appKey: 'k', apiUrl: 'https://invoice-api.amego.tw' }

// issueInvoiceForOrder 的品名會讀 useRuntimeConfig(Nitro 自動注入,測試環境沒有)
vi.stubGlobal('useRuntimeConfig', () => ({ public: { brandName: 'MiniMe' } }))

/**
 * 最小可用的假 Firestore:
 * - paymentOrders 支援 where('invoiceStatus'==skipped).where('status'==paid).limit().get()
 *   (查詢條件在這裡寫死——測試要驗的是「掃出來之後」的挑選規則,不是重造查詢引擎)
 * - invoices / workspaces / organizations 支援 doc().get()/set()/update()
 */
function fakeDb(orders: Record<string, Record<string, unknown>>) {
  const invoices: Record<string, Record<string, unknown>> = {}
  const updates: Record<string, Record<string, unknown>> = {}
  const db = {
    collection: (name: string) => ({
      where: () => ({
        where: () => ({
          limit: () => ({
            get: async () => ({
              docs: Object.entries(orders)
                .filter(([, o]) => o.invoiceStatus === 'skipped' && o.status === 'paid')
                .map(([id, o]) => ({ id, data: () => o })),
            }),
          }),
        }),
      }),
      doc: (id: string) => ({
        get: async () => {
          const store = name === 'invoices' ? invoices : name === 'paymentOrders' ? orders : {}
          const data = (store as Record<string, unknown>)[id]
          return { exists: data != null, data: () => data }
        },
        set: async (v: Record<string, unknown>) => { if (name === 'invoices') invoices[id] = v },
        update: async (v: Record<string, unknown>) => { updates[`${name}/${id}`] = { ...updates[`${name}/${id}`], ...v } },
      }),
    }),
  } as unknown as Firestore
  return { db, invoices, updates }
}

function paidOrder(no: string, amount: number, invoiceStatus = 'skipped') {
  return { merchantOrderNo: no, workspaceId: 'ws1', planId: 'lite', amount, status: 'paid', invoiceStatus }
}

beforeEach(() => vi.clearAllMocks())

describe('issueSkippedInvoices — 沒金鑰期間被跳過的發票,金鑰補上後撈回來開(B-26)', () => {
  it('skipped + paid + 金額>0 → 補開並記 issued、訂單標 issued', async () => {
    const { db, invoices, updates } = fakeDb({ NP1: paidOrder('NP1', 399) })
    const r = await issueSkippedInvoices(KEYS, db)
    expect(r).toEqual({ retried: 1, issued: 1 })
    expect(mockIssue).toHaveBeenCalledTimes(1)
    expect((invoices.NP1 as { ok: boolean }).ok).toBe(true)
    expect(updates['paymentOrders/NP1']?.invoiceStatus).toBe('issued')
  })

  it('金額 0(全額折抵)→ 維持 skipped 不動,不重試也不計數(B-21 未拍板前不能自作主張開零元發票)', async () => {
    const { db } = fakeDb({ NP2: paidOrder('NP2', 0) })
    const r = await issueSkippedInvoices(KEYS, db)
    expect(r).toEqual({ retried: 0, issued: 0 })
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('金鑰未設 → 什麼都不做(照舊 skipped,等金鑰補上那天自癒)', async () => {
    const { db } = fakeDb({ NP3: paidOrder('NP3', 399) })
    const r = await issueSkippedInvoices(null, db)
    expect(r).toEqual({ retried: 0, issued: 0 })
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('人工退款過的訂單不自動補開(自動開全額=幫退掉的錢開發票,留人工判斷)', async () => {
    const { db } = fakeDb({
      NP4: { ...paidOrder('NP4', 399), manualRefundTotal: 399 },
      NP5: { ...paidOrder('NP5', 399), manualRefundTotal: 100 }, // 部分退款也留人工
    })
    const r = await issueSkippedInvoices(KEYS, db)
    expect(r).toEqual({ retried: 0, issued: 0 })
    expect(mockIssue).not.toHaveBeenCalled()
  })
})
