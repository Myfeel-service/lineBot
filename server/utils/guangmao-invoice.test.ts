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

  it('三金額相加相等且含稅(財政部會檢核)', () => {
    const d = buildIssueInvoiceData({ ...base, profile: {} })
    expect(d.TotalAmount).toBe(499)
    expect(d.SalesAmount).toBe(475)
    expect(d.TaxAmount).toBe(24)
    expect(Number(d.SalesAmount) + Number(d.TaxAmount)).toBe(Number(d.TotalAmount))
  })

  it('B2C 無載具無捐贈 → 開紙本、買方統編為 10 個 0', () => {
    const d = buildIssueInvoiceData({ ...base, profile: {} })
    expect(d.BuyerIdentifier).toBe('0000000000')
    expect(d.PrintMark).toBe('Y')
    expect(d.BuyerName).toBe('MyFeel') // 沒填抬頭 → 用帳號名稱
    // B2C 單品項含稅
    expect((d.ProductItem as { UnitPrice: number }[])[0]!.UnitPrice).toBe(499)
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

  it('有統編 → B2B、買方統編帶入、必開紙本、單品項改未稅', () => {
    const d = buildIssueInvoiceData({
      ...base,
      profile: { buyerUBN: '12345678', buyerName: '好感覺股份有限公司', carrierNum: '/ABC1234' },
    })
    expect(d.BuyerIdentifier).toBe('12345678')
    expect(d.PrintMark).toBe('Y')
    expect((d.ProductItem as { UnitPrice: number }[])[0]!.UnitPrice).toBe(475) // 未稅
    // B2B 不吃載具，就算填了也不能送
    expect(d.CarrierType).toBeUndefined()
  })
})

describe('buildVoidInvoiceData — 作廢', () => {
  it('帶發票號碼、開立日期、作廢原因', () => {
    const d = buildVoidInvoiceData({ invoiceNumber: 'AB12345678', invoiceDate: '20260727', reason: '訂單取消' })
    expect(d.InvoiceNumber).toBe('AB12345678')
    expect(d.InvoiceDate).toBe('20260727')
    expect(d.CancelReason).toBe('訂單取消')
  })
})

describe('buildAllowanceData — 折讓', () => {
  it('對原發票開折讓、金額三者相加相等、品項帶原發票號碼', () => {
    const d = buildAllowanceData({ invoiceNumber: 'AB12345678', itemName: '方案折讓', totalAmt: 210 })
    expect(d.InvoiceNumber).toBe('AB12345678')
    expect(Number(d.TotalAmount)).toBe(210)
    expect(Number((d.ProductItem as { Amount: number }[])[0]!.Amount) + Number(d.TaxAmount)).toBe(Number(d.TotalAmount))
    expect((d.ProductItem as { OriginalInvoiceNumber: string }[])[0]!.OriginalInvoiceNumber).toBe('AB12345678')
  })

  it('未給折讓單號 → 不帶 AllowanceNumber(交由光貿配號)', () => {
    const d = buildAllowanceData({ invoiceNumber: 'AB12345678', itemName: '方案折讓', totalAmt: 210 })
    expect(d.AllowanceNumber).toBeUndefined()
  })
})
