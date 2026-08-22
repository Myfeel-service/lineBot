import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 客戶端看發票的兩支端點（`B-44`⑤：兩支都會把「別人的發票」端出去，一直沒有測試）。
 *
 * 釘住的是三件事：
 *   ① **跨帳號**：發票文件 id ＝ 訂單編號，猜得到；歸屬一定要驗，否則換個編號就看得到
 *      別的官方帳號的統編、抬頭、金額
 *   ② **作廢的發票不給下載證明聯**：作廢後那張紙沒有報帳效力，給了只會被拿去報帳
 *   ③ **快照原則**：開給誰／品名用開立當下的快照，舊發票沒快照就回 null／標「回推」，不猜
 */

const KEYS = {
  guangmaoInvoiceSellerUBN: '83610942',
  guangmaoInvoiceAppKey: 'test-key',
  guangmaoInvoiceApiUrl: 'https://invoice-api.amego.tw',
  public: { brandName: 'MiniMe' },
}

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: 'ws1' })),
}))
vi.mock('~~/server/utils/guangmao-invoice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~~/server/utils/guangmao-invoice')>()),
  getInvoiceFileUrl: vi.fn(),
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))
vi.stubGlobal('useRuntimeConfig', () => KEYS)

let query: Record<string, string> = {}
vi.stubGlobal('getQuery', () => query)

const { default: detailHandler } = await import('./invoice-detail.get')
const { default: fileHandler } = await import('./invoice-file.get')
const { getDb } = await import('~~/server/utils/firebase')
const { getInvoiceFileUrl } = await import('~~/server/utils/guangmao-invoice')

const mockGetDb = vi.mocked(getDb)
const mockFileUrl = vi.mocked(getInvoiceFileUrl)

function invoiceDoc(patch: Record<string, unknown> = {}) {
  return {
    ok: true,
    invoiceNumber: 'ZA10035769',
    workspaceId: 'ws1',
    totalAmt: 399,
    amt: 380,
    taxAmt: 19,
    randomNum: '1234',
    buyerIdentifier: '83610942',
    buyerName: '麥菲爾股份有限公司',
    itemName: 'MiniMe 輕量方案(1 個月)',
    createdAt: { toMillis: () => 1_755_000_000_000 },
    ...patch,
  }
}

/** invoices 與 paymentOrders 兩個 collection 各給一份文件 */
function makeDb(inv: Record<string, unknown> | null, order: Record<string, unknown> | null = null) {
  const db = {
    collection: (col: string) => ({
      doc: () => ({
        get: async () => col === 'invoices'
          ? { exists: inv !== null, data: () => inv }
          : { exists: order !== null, data: () => order },
      }),
    }),
  }
  mockGetDb.mockReturnValue(db as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  query = { order: 'MF001' }
})

describe('發票明細', () => {
  it('🔴 別的官方帳號的發票看不到（文件 id ＝ 訂單編號，猜得到）', async () => {
    makeDb(invoiceDoc({ workspaceId: 'ws-other' }))
    await expect(detailHandler({} as never)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('沒帶訂單編號回 400', async () => {
    makeDb(invoiceDoc())
    query = {}
    await expect(detailHandler({} as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('公司發票：帶出隨機碼、統編、抬頭、品名，金額三欄相加對得起來', async () => {
    makeDb(invoiceDoc())
    const d = await detailHandler({} as never) as Record<string, unknown>
    expect(d).toMatchObject({
      invoiceNumber: 'ZA10035769',
      randomNum: '1234',
      buyerType: 'b2b',
      buyerUBN: '83610942',
      itemName: 'MiniMe 輕量方案(1 個月)',
      itemNameDerived: false,
      netAmt: 399,
    })
    expect((d.amt as number) + (d.taxAmt as number)).toBe(d.totalAmt)
  })

  it('個人發票：送出去的佔位統編不能被當成「開給公司」', async () => {
    makeDb(invoiceDoc({ buyerIdentifier: '0000000000', buyerName: '' }))
    const d = await detailHandler({} as never) as Record<string, unknown>
    expect(d).toMatchObject({ buyerType: 'b2c', buyerUBN: null })
  })

  it('快照上線前的舊發票：開給誰回 null（不猜），品名用方案名回推並標記', async () => {
    makeDb(invoiceDoc({ buyerIdentifier: '', itemName: '' }), { planId: 'lite' })
    const d = await detailHandler({} as never) as Record<string, unknown>
    expect(d.buyerType).toBeNull()
    expect(d.itemNameDerived).toBe(true)
    expect(String(d.itemName)).toContain('MiniMe')
  })

  it('開過折讓：折讓後的實際金額＝原金額扣掉折讓總額', async () => {
    makeDb(invoiceDoc({
      allowances: [
        { allowanceNumber: 'A1', amount: 100, reason: '部分退款', createdAtMs: 1 },
        { allowanceNumber: 'A2', amount: 99, reason: '再退', createdAtMs: 2 },
      ],
    }))
    const d = await detailHandler({} as never) as Record<string, unknown>
    expect(d).toMatchObject({ allowanceTotal: 199, netAmt: 200 })
  })

  it('作廢過的發票照樣看得到明細（要查得到當初為什麼作廢）', async () => {
    makeDb(invoiceDoc({ voided: true, voidReason: '統編打錯' }))
    const d = await detailHandler({} as never) as Record<string, unknown>
    expect(d).toMatchObject({ voided: true, voidReason: '統編打錯' })
  })
})

describe('證明聯 PDF', () => {
  it('🔴 別的官方帳號的發票下載不到', async () => {
    makeDb(invoiceDoc({ workspaceId: 'ws-other' }))
    await expect(fileHandler({} as never)).rejects.toMatchObject({ statusCode: 403 })
    expect(mockFileUrl).not.toHaveBeenCalled()
  })

  it('🔴 作廢過的發票不給下載（沒有報帳效力）', async () => {
    makeDb(invoiceDoc({ voided: true }))
    await expect(fileHandler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(mockFileUrl).not.toHaveBeenCalled()
  })

  it('沒開成功的發票沒有 PDF 可拿', async () => {
    makeDb(invoiceDoc({ ok: false, invoiceNumber: '' }))
    await expect(fileHandler({} as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('逾 180 天等光貲端原因原樣帶回（使用者才知道不是我們壞掉）', async () => {
    makeDb(invoiceDoc())
    mockFileUrl.mockResolvedValue({ ok: false, status: '51', message: '超過查詢期限' })
    await expect(fileHandler({} as never)).rejects.toMatchObject({
      statusCode: 502,
      statusMessage: expect.stringContaining('超過查詢期限'),
    })
  })

  it('成功時回當下取到的連結（10 分鐘就失效，所以每次都重新取）', async () => {
    makeDb(invoiceDoc())
    mockFileUrl.mockResolvedValue({ ok: true, status: '0', message: '', fileUrl: 'https://invoice.amego.tw/f/abc' })
    await expect(fileHandler({} as never)).resolves.toEqual({ fileUrl: 'https://invoice.amego.tw/f/abc' })
    expect(mockFileUrl).toHaveBeenCalledWith({ invoiceNumber: 'ZA10035769' }, expect.anything())
  })
})
