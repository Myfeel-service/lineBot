import { describe, expect, it } from 'vitest'
import { checkoutProductName, invoiceProductName } from './product-name'

const base = { serviceFullName: 'LINE MiniMe AI CRM 與客服系統', brandName: 'MiniMe', planName: '輕量' }

describe('商品名稱三處對齊（B-33）', () => {
  // 風控會拿官網／付款頁／發票三處互相核對，主體對不上就是被退件的理由
  it('付款頁與發票品名都以申報的商品名稱開頭', () => {
    expect(checkoutProductName({ ...base, recurring: true }).startsWith(base.serviceFullName)).toBe(true)
    expect(invoiceProductName(base).startsWith(base.serviceFullName)).toBe(true)
  })

  it('括號各自補充：付款頁講扣款方式，發票講服務期間', () => {
    expect(checkoutProductName({ ...base, recurring: true })).toBe('LINE MiniMe AI CRM 與客服系統｜輕量方案（每月自動扣款）')
    expect(checkoutProductName({ ...base, recurring: false })).toBe('LINE MiniMe AI CRM 與客服系統｜輕量方案（1 個月）')
    expect(invoiceProductName(base)).toBe('LINE MiniMe AI CRM 與客服系統｜輕量方案（1 個月）')
  })

  // 發票是「這一期」的憑證，寫成每月自動扣款會像在收未來的錢
  it('發票品名不論是否自動續訂都一樣，不寫扣款方式', () => {
    expect(invoiceProductName(base)).not.toContain('自動扣款')
  })

  it('沒設申報名稱時退回品牌名，不會產出開頭是「｜」的怪字串', () => {
    expect(invoiceProductName({ ...base, serviceFullName: '' })).toBe('MiniMe｜輕量方案（1 個月）')
    expect(invoiceProductName({ serviceFullName: '', brandName: '', planName: '輕量' })).toBe('MiniMe｜輕量方案（1 個月）')
  })

  // 2026-08-16 實測：37 字送 PAYUNi 正式付款頁，顯示一字不差
  it('長度在 PAYUNi 付款頁實測可接受的範圍內', () => {
    expect(checkoutProductName({ ...base, planName: '專業', recurring: true }).length).toBeLessThanOrEqual(50)
  })
})
