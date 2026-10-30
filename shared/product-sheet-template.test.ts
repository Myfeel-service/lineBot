import { describe, expect, it } from 'vitest'
import { PRODUCT_SHEET_TEMPLATE } from './product-sheet-template'
import { findProductPageHeader, isSheetCatalogHeader, isSheetControlHeader, SHEET_FAQ_HEADER } from './sheet-products'

/**
 * 「幫我開一份商品表」開出來的欄名，系統要真的認得（`C-448`）。
 * 欄名一改（例如改成「商品網址連結」以外的寫法、「放進目錄」打錯），開出來的表照樣讀得到，
 * 只是商品圖不抓、目錄永遠是空的——後台沒有任何地方會紅。這支就是那個紅燈。
 */
describe('商品試算表範本', () => {
  const { headers } = PRODUCT_SHEET_TEMPLATE

  it('第一欄是商品名', () => {
    expect(headers[0]).toBe('商品名')
  })

  it('「商品頁面」被認成商品頁那一欄（抓商品圖、做「查看商品頁」）', () => {
    expect(findProductPageHeader(headers.filter(h => !isSheetControlHeader(h)))).toBe('商品頁面')
  })

  it('「放進LINE目錄」被認成目錄開關（不給 AI 讀）', () => {
    expect(headers.filter(h => isSheetCatalogHeader(h))).toEqual(['放進LINE目錄'])
  })

  it('有「常見問答頁」那一欄', () => {
    expect(headers).toContain(SHEET_FAQ_HEADER)
  })

  it('每一欄都有註解、欄寬（少一個，那一欄就沒說明或擠成預設寬）', () => {
    expect(PRODUCT_SHEET_TEMPLATE.notes).toHaveLength(headers.length)
    expect(PRODUCT_SHEET_TEMPLATE.widths).toHaveLength(headers.length)
  })
})
