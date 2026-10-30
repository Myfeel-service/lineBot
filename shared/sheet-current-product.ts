import {
  SHEET_FIELD_IMAGE,
  SHEET_FIELD_NAME,
  isCurrentProductRef,
  replaceSheetFieldTokens,
  usesCurrentProduct,
} from './sheet-field'
import { firstHttpUrl } from './sheet-products'

/**
 * 商品資訊範本（`C-437`，`D-166` ⑤）：一份回覆給所有商品用，客人在商品目錄點了哪個商品，就填那個商品的格子。
 * 送出端（`server/utils/sheet-field-hydrate.ts`）跟編輯頁的預覽同一支，預覽才不會說謊。
 *
 * 規則（規格 `docs/PRODUCT-SHEET-CATALOG-DESIGN-20261030.md` §5.4）：
 *  - 試算表上空白的那一格：**那一行整行不顯示**（「出貨時間：」後面空著比沒寫更糟）；拿掉之後連著的空行收成一行。
 *  - 網址（`uri`）：取格子裡第一個 https 網址——「商品頁面」那格是「以下提供商品頁面連結供您參考： https://…」這種句子。
 *    取不到＝**那顆按鈕不顯示**（LINE 不收空網址，整則會被退）。
 *  - 圖（`imageUrl`）：這個商品沒有圖＝這則改回不帶圖（標題一起拿掉，沒圖的文字不畫標題）。
 *  - 整則被拿光（沒字、沒圖、沒按鈕）＝這一則不送（LINE 不收空白文字）。
 *  - 不是從商品目錄點進來的（關鍵字、別的按鈕）＝沒有「這個商品」，上面每一條都當空白處理。
 * ⛔ 列名寫死的格子（`{{sheet:Giaretti…|出貨時間}}`）不在這裡處理，照 `C-423` 的規則（換不到用存檔當時的內容）。
 */

export interface SheetCurrentProduct {
  title: string
  /** 商品目錄上那張圖；沒有＝空字串 */
  imageUrl: string
  /** 試算表上這一列每一欄現在寫的（空白的格子不在裡面）；表上找不到這一列＝{} */
  values: Record<string, string>
}

const DROP = Symbol('drop')

function currentValue(product: SheetCurrentProduct | null, field: string): string {
  if (!product) return ''
  if (field === SHEET_FIELD_NAME) return product.title
  if (field === SHEET_FIELD_IMAGE) return product.imageUrl
  return product.values[field] ?? ''
}

/** 一段字：有空白格的那一行整行拿掉，其他換成這個商品的 */
export function fillCurrentProductText(text: string, product: SheetCurrentProduct | null): string {
  if (!usesCurrentProduct(text)) return text
  let dropped = false
  const lines = text.split('\n').flatMap((line) => {
    let blank = false
    const out = replaceSheetFieldTokens(line, (ref, token) => {
      if (!isCurrentProductRef(ref)) return token
      const v = currentValue(product, ref.field)
      if (!v.trim()) blank = true
      return v
    })
    if (blank) {
      dropped = true
      return []
    }
    return [out]
  })
  const out = lines.join('\n')
  return dropped ? out.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '') : out
}

function fill(value: unknown, key: string, product: SheetCurrentProduct | null, depth = 0): unknown {
  if (typeof value === 'string') {
    if (!usesCurrentProduct(value)) return value
    const filled = fillCurrentProductText(value, product)
    return key === 'uri' ? (firstHttpUrl(filled) ?? '') : filled
  }
  if (Array.isArray(value)) return value.map(v => fill(v, '', product, depth + 1)).filter(v => v !== DROP)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(src)) {
      const w = fill(v, k, product, depth + 1)
      if (w !== DROP) out[k] = w
    }
    // 網址是這個商品的、填出來是空的＝這顆按鈕（或點圖的動作）拿掉
    if (out.type === 'uri' && usesCurrentProduct(src.uri) && !out.uri) return DROP
    // `C-438` code review：按鈕上的字、按了代客人送出的字用了這個商品的格子、填出來是空的＝也拿掉
    // （⛔ 留下空字串 LINE 會整則退回）。整則訊息本身（depth 0）的內文空了由外面那一層決定
    if (depth > 0 && emptyAfterFill(src.label, out.label)) return DROP
    if (depth > 0 && out.type === 'message' && emptyAfterFill(src.text, out.text)) return DROP
    return out
  }
  return value
}

const emptyAfterFill = (before: unknown, after: unknown) => usesCurrentProduct(before) && !String(after ?? '').trim()

/** 一組訊息裡用到「這個商品」的都填好（沒用到的原樣回）。`product` 是 null＝不是從商品目錄點進來的 */
export function fillSheetCurrentProduct(messages: any[], product: SheetCurrentProduct | null): any[] {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((msg) => {
    if (!msg || typeof msg !== 'object' || !usesCurrentProductDeep(msg)) return [msg]
    const out = fill(msg, '', product) as Record<string, any>
    if (out.type !== 'text') return [out]
    if (usesCurrentProduct(msg.imageUrl) && !String(out.imageUrl ?? '').trim()) {
      const { imageUrl: _i, imageWidth: _w, imageHeight: _h, title: _t, ...rest } = out
      return emptyText(rest) ? [] : [rest]
    }
    return emptyText(out) ? [] : [out]
  })
}

function emptyText(msg: Record<string, any>): boolean {
  return !String(msg.text ?? '').trim() && !String(msg.imageUrl ?? '').trim() && !(Array.isArray(msg.buttons) && msg.buttons.length)
}

/** 一則訊息（或一組）裡哪裡用到了「這個商品」 */
export function usesCurrentProductDeep(value: unknown): boolean {
  if (typeof value === 'string') return usesCurrentProduct(value)
  if (Array.isArray(value)) return value.some(usesCurrentProductDeep)
  if (value && typeof value === 'object') return Object.values(value).some(usesCurrentProductDeep)
  return false
}
