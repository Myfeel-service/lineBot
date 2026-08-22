import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 作廢（f0501）與折讓（g0401）兩支超管端點的 API 級測試（`B-44`⑤：這兩支會動到已開出去的
 * 發票，卻一直沒有任何測試）。
 *
 * 釘住的是「會變成稅務問題」的那幾條，不是實作細節：
 *   ① 光貲說失敗時，我方**不可以**在資料庫標成已作廢／已折讓——帳實不符比作廢失敗嚴重得多，
 *      對帳時會以為那張發票已經沒了，實際上它還在財政部平台
 *   ② 已作廢的發票不能再開折讓、已開折讓的發票不能直接作廢（折讓證明單還掛在原發票上）
 *   ③ 折讓累加後不得超過原發票金額（部分折讓多次是常態，第二次不檢查就會超折）
 *   ④ 作廢原因是財政部規定必填
 *   ⑤ 訂單那份摘要（列表用來標「已作廢／已折讓」）要跟著更新，否則列表說沒退、明細說退了
 */

const KEYS = {
  guangmaoInvoiceSellerUBN: '83610942',
  guangmaoInvoiceAppKey: 'test-key',
  guangmaoInvoiceApiUrl: 'https://invoice-api.amego.tw',
}

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ts__',
    arrayUnion: (v: unknown) => ({ __arrayUnion: v }),
  },
}))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({ requireSuperAdmin: vi.fn(async () => ({ uid: 'super' })) }))
// 只換掉真的會打光貲的兩支，其餘（isInvoiceConfigured 等）沿用原本實作
vi.mock('~~/server/utils/guangmao-invoice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~~/server/utils/guangmao-invoice')>()),
  voidInvoice: vi.fn(),
  issueAllowance: vi.fn(),
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))
vi.stubGlobal('useRuntimeConfig', () => KEYS)

let body: Record<string, unknown> = {}
vi.stubGlobal('readBody', async () => body)

const { default: voidHandler } = await import('./void-invoice.post')
const { default: allowanceHandler } = await import('./allowance.post')
const { getDb } = await import('~~/server/utils/firebase')
const { voidInvoice, issueAllowance } = await import('~~/server/utils/guangmao-invoice')

const mockGetDb = vi.mocked(getDb)
const mockVoid = vi.mocked(voidInvoice)
const mockAllowance = vi.mocked(issueAllowance)

/** 發票文件的預設樣子＝一張正常開出去、399 元、有買方快照的公司發票 */
function invoiceDoc(patch: Record<string, unknown> = {}) {
  return {
    ok: true,
    invoiceNumber: 'ZA10035769',
    workspaceId: 'ws1',
    totalAmt: 399,
    buyerName: '麥菲爾股份有限公司',
    buyerIdentifier: '83610942',
    createdAt: { toMillis: () => Date.parse('2026-08-16T02:00:00Z') },
    ...patch,
  }
}

/** 記下所有寫入，讓「光貲失敗時不可以寫」這條驗得到 */
function makeDb(doc: Record<string, unknown> | null) {
  const writes: Array<{ col: string, patch: Record<string, unknown> }> = []
  const refFor = (col: string) => ({
    get: async () => ({ exists: doc !== null, data: () => doc }),
    update: async (patch: Record<string, unknown>) => { writes.push({ col, patch }) },
  })
  const db = { collection: (col: string) => ({ doc: () => refFor(col) }) }
  mockGetDb.mockReturnValue(db as never)
  return writes
}

beforeEach(() => {
  vi.clearAllMocks()
  body = {}
})

describe('作廢發票', () => {
  it('沒填原因就擋下（財政部規定必填），而且不會去打光貲', async () => {
    makeDb(invoiceDoc())
    body = { merchantOrderNo: 'MF001' }
    await expect(voidHandler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(mockVoid).not.toHaveBeenCalled()
  })

  it('查無發票回 404', async () => {
    makeDb(null)
    body = { merchantOrderNo: 'MF404', reason: '開錯統編' }
    await expect(voidHandler({} as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('已作廢的不重複作廢', async () => {
    makeDb(invoiceDoc({ voided: true }))
    body = { merchantOrderNo: 'MF001', reason: '開錯統編' }
    await expect(voidHandler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(mockVoid).not.toHaveBeenCalled()
  })

  it('已開過折讓的發票不能直接作廢', async () => {
    makeDb(invoiceDoc({ allowances: [{ allowanceNumber: 'A1', amount: 100 }] }))
    body = { merchantOrderNo: 'MF001', reason: '客戶退款' }
    await expect(voidHandler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(mockVoid).not.toHaveBeenCalled()
  })

  it('沒開成功的發票沒有東西可以作廢', async () => {
    makeDb(invoiceDoc({ ok: false, invoiceNumber: '' }))
    body = { merchantOrderNo: 'MF001', reason: '開錯' }
    await expect(voidHandler({} as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('🔴 光貲說作廢失敗（逾時效）→ 回 502，而且資料庫一個字都不能改', async () => {
    const writes = makeDb(invoiceDoc())
    mockVoid.mockResolvedValue({ ok: false, status: '4010007', message: '已逾作廢期限' })
    body = { merchantOrderNo: 'MF001', reason: '開錯統編' }
    await expect(voidHandler({} as never)).rejects.toMatchObject({ statusCode: 502 })
    expect(writes).toEqual([])
  })

  it('作廢成功：發票標作廢＋訂單摘要同步標作廢（列表才看得出來）', async () => {
    const writes = makeDb(invoiceDoc())
    mockVoid.mockResolvedValue({ ok: true, status: '0', message: '' })
    body = { merchantOrderNo: 'MF001', reason: '開錯統編' }
    const res = await voidHandler({} as never)
    expect(res).toMatchObject({ ok: true, invoiceNumber: 'ZA10035769' })
    // 帶給光貲的發票日期＝開立當天（台灣時區），不是今天
    expect(mockVoid).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceNumber: 'ZA10035769', invoiceDate: '20260816' }),
      expect.anything(),
    )
    expect(writes.map(w => w.col)).toEqual(['invoices', 'paymentOrders'])
    expect(writes[0]!.patch).toMatchObject({ voided: true, voidReason: '開錯統編' })
    expect(writes[1]!.patch).toMatchObject({ invoiceStatus: 'voided' })
  })
})

describe('開折讓', () => {
  it('金額不是正整數就擋下', async () => {
    makeDb(invoiceDoc())
    body = { merchantOrderNo: 'MF001', reason: '退款折讓', amount: 0 }
    await expect(allowanceHandler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(mockAllowance).not.toHaveBeenCalled()
  })

  it('已作廢的發票不能再開折讓', async () => {
    makeDb(invoiceDoc({ voided: true }))
    body = { merchantOrderNo: 'MF001', reason: '退款折讓', amount: 100 }
    await expect(allowanceHandler({} as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('買方快照上線前的舊發票擋下請人工處理（折讓抬頭須與原發票一致）', async () => {
    makeDb(invoiceDoc({ buyerName: '', buyerIdentifier: '' }))
    body = { merchantOrderNo: 'MF001', reason: '退款折讓', amount: 100 }
    await expect(allowanceHandler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(mockAllowance).not.toHaveBeenCalled()
  })

  it('🔴 部分折讓累加後超過原發票金額 → 擋下（第二次折讓最容易超折）', async () => {
    makeDb(invoiceDoc({ allowances: [{ allowanceNumber: 'A1', amount: 300, reason: '前次', status: '0', createdAtMs: 1 }] }))
    body = { merchantOrderNo: 'MF001', reason: '再退', amount: 100 } // 300 + 100 > 399
    await expect(allowanceHandler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(mockAllowance).not.toHaveBeenCalled()
  })

  it('🔴 光貲說折讓失敗 → 回 502，資料庫不留半筆折讓紀錄', async () => {
    const writes = makeDb(invoiceDoc())
    mockAllowance.mockResolvedValue({ ok: false, status: '4040127', message: '買方資訊與原發票不符' })
    body = { merchantOrderNo: 'MF001', reason: '退款折讓', amount: 100 }
    await expect(allowanceHandler({} as never)).rejects.toMatchObject({ statusCode: 502 })
    expect(writes).toEqual([])
  })

  it('折讓成功：發票加一筆紀錄＋訂單累計金額＝舊的加新的，回傳剩餘可折金額', async () => {
    const writes = makeDb(invoiceDoc({ allowances: [{ allowanceNumber: 'A1', amount: 99, reason: '前次', status: '0', createdAtMs: 1 }] }))
    mockAllowance.mockResolvedValue({ ok: true, status: '0', message: '' })
    body = { merchantOrderNo: 'MF001', reason: '退款折讓', amount: 100 }
    const res = await allowanceHandler({} as never) as { ok: boolean, remaining: number }
    expect(res.ok).toBe(true)
    expect(res.remaining).toBe(200) // 399 − 99 − 100
    expect(writes.map(w => w.col)).toEqual(['invoices', 'paymentOrders'])
    expect(writes[0]!.patch.allowances).toMatchObject({ __arrayUnion: { amount: 100, reason: '退款折讓' } })
    expect(writes[1]!.patch).toMatchObject({ invoiceAllowanceTotal: 199 })
    // 折讓抬頭一律取原發票快照，不重算現行設定
    expect(mockAllowance).toHaveBeenCalledWith(
      expect.objectContaining({ buyerIdentifier: '83610942', buyerName: '麥菲爾股份有限公司', invoiceDate: '20260816' }),
      expect.anything(),
    )
  })
})
