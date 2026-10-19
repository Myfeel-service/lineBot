import { describe, expect, it } from 'vitest'
import {
  checkoutInvoiceLine,
  DEFAULT_MAX_WORKSPACES_PER_ORG,
  hasInvoiceProfile,
  resolveInvoiceProfile,
  type InvoiceProfile,
} from './organization'

describe('DEFAULT_MAX_WORKSPACES_PER_ORG — 濫用防護', () => {
  it('必須是個有限的正整數', () => {
    // 每個新官方帳號都自帶 200 則免費額度。這個上限一旦消失（變成 0 / null / Infinity），
    // 自助註冊就等於「一個人可以無限建帳號換無限免費額度」。
    expect(Number.isInteger(DEFAULT_MAX_WORKSPACES_PER_ORG)).toBe(true)
    expect(DEFAULT_MAX_WORKSPACES_PER_ORG).toBeGreaterThan(0)
    expect(DEFAULT_MAX_WORKSPACES_PER_ORG).toBeLessThan(100)
  })
})

const ORG: InvoiceProfile = {
  buyerUBN: '12345678',
  buyerName: '好感覺股份有限公司',
  buyerEmail: 'acc@myfeel.tw',
  carrierNum: null,
  loveCode: null,
}

describe('hasInvoiceProfile', () => {
  it('全空 / undefined → 沒填', () => {
    expect(hasInvoiceProfile(undefined)).toBe(false)
    expect(hasInvoiceProfile({})).toBe(false)
    expect(hasInvoiceProfile({ buyerUBN: null, buyerName: '', carrierNum: '  ' })).toBe(false)
  })
  it('任一欄位有值 → 有填', () => {
    expect(hasInvoiceProfile({ carrierNum: '/ABC1234' })).toBe(true)
    expect(hasInvoiceProfile({ buyerName: '王小明' })).toBe(true)
  })
})

describe('resolveInvoiceProfile — 組織預設 + 官方帳號覆寫', () => {
  it('OA 沒填 → 沿用組織的（統編只要填一次，底下所有 OA 都適用）', () => {
    expect(resolveInvoiceProfile(ORG, undefined)).toEqual(ORG)
    expect(resolveInvoiceProfile(ORG, {})).toEqual(ORG)
  })

  it('OA 有填 → **整份**取代，不做逐欄位合併', () => {
    // 這是最重要的一條：逐欄位合併會組出「A 公司的抬頭 + B 公司的統編」這種混合體，
    // 那是一張報不了帳、甚至有稅務問題的發票。買受人身分必須是完整的一組。
    const ws: InvoiceProfile = { buyerName: '王小明', carrierNum: '/ABC1234' }
    const r = resolveInvoiceProfile(ORG, ws)

    expect(r).toEqual(ws)
    expect(r.buyerUBN).toBeUndefined() // ← 絕不能從組織漏進來
    expect(r.buyerEmail).toBeUndefined()
  })

  it('組織與 OA 都沒填 → 空（開個人紙本發票）', () => {
    expect(resolveInvoiceProfile(null, null)).toEqual({})
  })
})

describe('checkoutInvoiceLine（付款前「會開出什麼發票」，三條結帳路徑共用；`B-44`⑩）', () => {
  it('公司統編 → 講統編與抬頭、通知寄到哪', () => {
    expect(checkoutInvoiceLine({ buyerUBN: '83610942', buyerName: '麥菲爾股份有限公司', buyerEmail: 'ap@example.com' }))
      .toBe('發票：公司發票（統編 83610942・麥菲爾股份有限公司），通知寄到 ap@example.com')
  })

  it('載具 → 不說「寄到」（發票直接進載具）', () => {
    expect(checkoutInvoiceLine({ carrierNum: '/ABC1234' })).toBe('發票：個人發票・存入手機條碼載具 /ABC1234（存入載具，不另寄通知信）')
  })

  it('沒填過 → 個人紙本、通知寄到登入信箱', () => {
    expect(checkoutInvoiceLine({})).toBe('發票：個人發票・紙本，通知寄到 你的登入信箱')
  })

  it('🔴 讀不到（null）→ 照實講讀不到，⛔ 不猜成「個人紙本」', () => {
    const line = checkoutInvoiceLine(null)
    expect(line).toContain('暫時讀不到')
    expect(line).not.toContain('紙本')
  })
})
