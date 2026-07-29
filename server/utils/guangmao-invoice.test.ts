import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { buildAllowanceData, buildIssueInvoiceData, buildVoidInvoiceData, isInvoiceConfigured, makeSign } from './guangmao-invoice'

const KEYS = {
  sellerUBN: '12345678',
  appKey: 'sHeq7t8G1wiQvhAuIM27', // 官方範例的 APP_KEY
  apiUrl: 'https://invoice-api.amego.tw',
}

describe('makeSign — md5(data + time + appKey)', () => {
  it('與手算 md5 一致', () => {
    const data = '{"OrderId":"NP1"}'
    const time = 1700000000
    const expected = createHash('md5').update(`${data}${time}${KEYS.appKey}`, 'utf8').digest('hex')
    expect(makeSign(data, time, KEYS.appKey)).toBe(expected)
  })

  it('data 差一個字元 → sign 就不同(避免各自 stringify 造成 code 16)', () => {
    const t = 1700000000
    expect(makeSign('{"a":1}', t, KEYS.appKey)).not.toBe(makeSign('{"a":2}', t, KEYS.appKey))
  })
})

describe('isInvoiceConfigured — 三值全設才啟用', () => {
  it('全設 → true', () => {
    expect(isInvoiceConfigured(KEYS)).toBe(true)
  })
  it('缺任一 → false(未開通不開發票、不擋收款)', () => {
    expect(isInvoiceConfigured({ ...KEYS, appKey: '' })).toBe(false)
    expect(isInvoiceConfigured({ ...KEYS, sellerUBN: '' })).toBe(false)
    expect(isInvoiceConfigured({ ...KEYS, apiUrl: '' })).toBe(false)
    expect(isInvoiceConfigured(null)).toBe(false)
  })
})

describe('buildIssueInvoiceData — 稅額與載具規則', () => {
  const base = { merchantOrderNo: 'NP1', totalAmt: 499, itemName: '入門方案 訂閱服務', fallbackBuyerName: 'MyFeel' }

  it('B2C 二聯式金額模型(已實測):SalesAmount 含稅、TaxAmount=0、皆字串', () => {
    const d = buildIssueInvoiceData({ ...base, profile: {} })
    expect(d.TotalAmount).toBe('499') // 字串,非數字
    expect(d.SalesAmount).toBe('499') // 二聯式:銷售額=含稅
    expect(d.TaxAmount).toBe('0') // 稅內含,不另拆
    expect(d.TaxRate).toBe('0.05') // 小數字串,非 5
    // 品項含稅、加總 = TotalAmount(光貲檢核基準)
    expect((d.ProductItem as { Amount: string }[])[0]!.Amount).toBe('499')
  })

  it('B2C 無載具無捐贈 → 開紙本、買方統編為 10 個 0', () => {
    const d = buildIssueInvoiceData({ ...base, profile: {} })
    expect(d.BuyerIdentifier).toBe('0000000000')
    expect(d.PrintMark).toBe('Y')
    expect(d.BuyerName).toBe('MyFeel') // 沒填抬頭 → 用帳號名稱
  })

  it('B2C 手機條碼載具 → 帶載具、不索取紙本、無捐贈', () => {
    const d = buildIssueInvoiceData({ ...base, profile: { carrierNum: '/ABC1234' } })
    expect(d.CarrierType).toBe('3J0002')
    expect(d.CarrierId1).toBe('/ABC1234')
    expect(d.PrintMark).toBe('N')
    expect(d.NPOBAN).toBeUndefined()
  })

  it('B2C 捐贈碼 → 帶 NPOBAN、不帶載具(兩者互斥)', () => {
    const d = buildIssueInvoiceData({ ...base, profile: { loveCode: '25885' } })
    expect(d.NPOBAN).toBe('25885')
    expect(d.CarrierType).toBeUndefined()
    expect(d.PrintMark).toBe('N')
  })

  it('有統編 → B2B 三聯式(已實測):SalesAmount 未稅+TaxAmount、品項仍含稅、必開紙本', () => {
    const d = buildIssueInvoiceData({
      ...base,
      profile: { buyerUBN: '12345678', buyerName: '好感覺股份有限公司', carrierNum: '/ABC1234' },
    })
    expect(d.BuyerIdentifier).toBe('12345678')
    expect(d.PrintMark).toBe('Y')
    expect(d.SalesAmount).toBe('475') // 三聯式:未稅
    expect(d.TaxAmount).toBe('24')
    expect(Number(d.SalesAmount) + Number(d.TaxAmount)).toBe(Number(d.TotalAmount)) // 475+24=499
    expect((d.ProductItem as { Amount: string }[])[0]!.Amount).toBe('499') // 品項含稅、加總=Total
    // B2B 不吃載具，就算填了也不能送
    expect(d.CarrierType).toBeUndefined()
  })
})

describe('buildVoidInvoiceData — 作廢(已實測)', () => {
  it('用 CancelInvoiceNumber(非 InvoiceNumber)、YYYYMMDD 日期、作廢原因', () => {
    const d = buildVoidInvoiceData({ invoiceNumber: 'AB12345678', invoiceDate: '20260727', reason: '訂單取消' })
    expect(d.CancelInvoiceNumber).toBe('AB12345678')
    expect(d.InvoiceNumber).toBeUndefined() // 實測:作廢欄位是 CancelInvoiceNumber
    expect(d.InvoiceDate).toBe('20260727')
    expect(d.CancelReason).toBe('訂單取消')
  })
})

describe('buildAllowanceData — 折讓(已實測)', () => {
  const allow = { invoiceNumber: 'AB12345678', invoiceDate: '20260728', itemName: '方案折讓', totalAmt: 210, allowanceNumber: 'AL0001', allowanceDate: '20260729', buyerName: 'MyFeel OA' }

  it('必填欄位:AllowanceType=2、AllowanceNumber、BuyerIdentifier 預設 B2C、BuyerName 帶入', () => {
    const d = buildAllowanceData(allow)
    expect(d.AllowanceType).toBe('2') // 賣方開立(1 已禁用)
    expect(d.AllowanceNumber).toBe('AL0001')
    expect(d.BuyerIdentifier).toBe('0000000000') // 未給 → B2C 預設
    expect(d.BuyerName).toBe('MyFeel OA') // 不可空,須對齊原發票
    expect(d.InvoiceNumber).toBe('AB12345678')
    expect(d.AllowanceDate).toBe('20260729')
  })

  it('品項未稅 Amount + 另帶 Tax、TotalAmount 含稅、帶原發票號碼與日期', () => {
    const d = buildAllowanceData(allow)
    expect(Number(d.TotalAmount)).toBe(210) // 含稅
    const item = (d.ProductItem as { Amount: string; Tax: string; OriginalInvoiceNumber: string; OriginalInvoiceDate: string }[])[0]!
    expect(Number(item.Amount)).toBe(200) // 未稅
    expect(Number(item.Tax)).toBe(10)
    expect(item.OriginalInvoiceNumber).toBe('AB12345678')
    expect(item.OriginalInvoiceDate).toBe('20260728')
  })

  it('B2B 折讓 → 帶入原買方統編', () => {
    const d = buildAllowanceData({ ...allow, buyerIdentifier: '22099131', buyerName: '台積電' })
    expect(d.BuyerIdentifier).toBe('22099131')
    expect(d.BuyerName).toBe('台積電')
  })
})
