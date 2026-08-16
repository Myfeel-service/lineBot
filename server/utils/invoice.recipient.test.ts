/**
 * 發票通知信「寄得到人」的護欄（`B-34`）。
 *
 * 發票通知是**光貿寄的**，而且只有帶了 BuyerEmailAddress 才會寄。客戶沒填帳務信箱時，
 * 發票照樣開出去、稅也報了，但他收不到通知、也不知道去哪拿——所以要退回登入帳號的信箱。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Firestore } from 'firebase-admin/firestore'

vi.mock('./guangmao-invoice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./guangmao-invoice')>()
  return {
    ...actual,
    issueInvoice: vi.fn(async () => ({ ok: true, status: '0', message: '', invoiceNumber: 'ZA10000002', randomNum: '0001' })),
  }
})
vi.mock('./firebase', () => ({ getDb: vi.fn(() => ({})) }))

import { issueInvoice } from './guangmao-invoice'
import { issueInvoiceForOrder } from './invoice'

const mockIssue = vi.mocked(issueInvoice)
const KEYS = { sellerUBN: '83610942', appKey: 'k', apiUrl: 'https://invoice-api.amego.tw' }

vi.stubGlobal('useRuntimeConfig', () => ({
  public: { brandName: 'MiniMe', serviceFullName: 'LINE MiniMe AI CRM 與客服系統' },
}))

/** 假 Firestore：只要能讀 workspaces / organizations、寫 invoices 與訂單即可。 */
function fakeDb(opts: { wsInvoiceProfile?: Record<string, unknown> | null, ownerEmail?: string | null }) {
  const docs: Record<string, Record<string, unknown> | undefined> = {
    'workspaces/ws1': { name: '小福商店', organizationId: 'org1', invoiceProfile: opts.wsInvoiceProfile ?? undefined },
    'organizations/org1': { ownerEmail: opts.ownerEmail ?? undefined },
    'paymentOrders/NP1': { merchantOrderNo: 'NP1', workspaceId: 'ws1', planId: 'lite', amount: 399, status: 'paid' },
  }
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({ exists: docs[`${name}/${id}`] != null, data: () => docs[`${name}/${id}`] }),
        set: async () => {},
        update: async () => {},
      }),
    }),
  } as unknown as Firestore
}

beforeEach(() => vi.clearAllMocks())

describe('發票通知信的收件人（B-34）', () => {
  it('沒填帳務信箱 → 退回組織擁有者（登入帳號）的信箱，光貿才寄得出通知', async () => {
    await issueInvoiceForOrder(
      { merchantOrderNo: 'NP1', workspaceId: 'ws1', planId: 'lite', totalAmt: 399 },
      KEYS,
      fakeDb({ ownerEmail: 'owner@example.com' }),
    )
    expect(mockIssue.mock.calls[0]![0].profile.buyerEmail).toBe('owner@example.com')
  })

  it('有填帳務信箱 → 照填的寄，不被登入信箱蓋掉', async () => {
    await issueInvoiceForOrder(
      { merchantOrderNo: 'NP1', workspaceId: 'ws1', planId: 'lite', totalAmt: 399 },
      KEYS,
      fakeDb({ wsInvoiceProfile: { buyerEmail: 'billing@example.com' }, ownerEmail: 'owner@example.com' }),
    )
    expect(mockIssue.mock.calls[0]![0].profile.buyerEmail).toBe('billing@example.com')
  })

  it('兩個都沒有 → 照樣開票（發票不能因為沒信箱就不開，那是稅務問題）', async () => {
    await issueInvoiceForOrder(
      { merchantOrderNo: 'NP1', workspaceId: 'ws1', planId: 'lite', totalAmt: 399 },
      KEYS,
      fakeDb({}),
    )
    expect(mockIssue).toHaveBeenCalledTimes(1)
    expect(mockIssue.mock.calls[0]![0].profile.buyerEmail).toBeFalsy()
  })

  // B-31 第二道防線：存檔時漏過去的錯載具，開票時要自己救回來
  it('載具無效（3040132）→ 自動拿掉載具改開紙本，不讓那筆訂單永遠沒有發票', async () => {
    mockIssue
      .mockResolvedValueOnce({ ok: false, status: '3040132', message: '載具號碼不存在' })
      .mockResolvedValueOnce({ ok: true, status: '0', message: '', invoiceNumber: 'ZA10000003', randomNum: '0002' })

    await issueInvoiceForOrder(
      { merchantOrderNo: 'NP1', workspaceId: 'ws1', planId: 'lite', totalAmt: 399 },
      KEYS,
      fakeDb({ wsInvoiceProfile: { carrierNum: '/ABC1234' }, ownerEmail: 'owner@example.com' }),
    )

    expect(mockIssue).toHaveBeenCalledTimes(2)
    expect(mockIssue.mock.calls[0]![0].profile.carrierNum).toBe('/ABC1234')
    expect(mockIssue.mock.calls[1]![0].profile.carrierNum).toBeNull() // 第二次改開紙本
  })

  it('一般失敗（平台維護之類）不改開紙本——那種重試會好，不該把載具丟掉', async () => {
    mockIssue.mockResolvedValueOnce({ ok: false, status: '10', message: '系統停機維護中' })
    await issueInvoiceForOrder(
      { merchantOrderNo: 'NP1', workspaceId: 'ws1', planId: 'lite', totalAmt: 399 },
      KEYS,
      fakeDb({ wsInvoiceProfile: { carrierNum: '/ABC1234' }, ownerEmail: 'owner@example.com' }),
    )
    expect(mockIssue).toHaveBeenCalledTimes(1)
  })

  // 品名開出去就改不掉（光貿與財政部都不允許事後更正），格式要釘死
  it('發票品名＝申報商品名稱｜方案（1 個月），與付款頁主體逐字相同（B-33）', async () => {
    await issueInvoiceForOrder(
      { merchantOrderNo: 'NP1', workspaceId: 'ws1', planId: 'lite', totalAmt: 399 },
      KEYS,
      fakeDb({ ownerEmail: 'owner@example.com' }),
    )
    expect(mockIssue.mock.calls[0]![0].itemName).toBe('LINE MiniMe AI CRM 與客服系統｜輕量方案（1 個月）')
  })
})
