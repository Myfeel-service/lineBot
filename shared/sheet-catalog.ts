/**
 * 商品目錄「照試算表排」（`C-436`，`D-166` ⑤「商品的事都在試算表做」，規格 `docs/PRODUCT-SHEET-CATALOG-DESIGN-20261030.md` §5.3）。
 *
 * 卡片訊息（`flexImageCarousel`）多一格 `sheetSource` 就是照試算表排：卡片不存在模組裡，**送出時**照商品清單產生——
 * 「放進LINE目錄」打勾、有圖的商品，照試算表的順序，最多 10 張（LINE 一則的上限）。
 * 每張卡＝整張圖（跟 MYFEEL 現在一樣），點了送 `tapModuleId`（商品資訊範本）並帶上是哪個商品、貼這個商品的標籤。
 *
 * ⛔ 截掉、沒放上去的都講得出是哪幾個（`planSheetCatalog` 的 overflow／noImage，提醒 `C-438` 讀這裡），不默默少一張。
 */
import { productImage, type SheetProduct, type SheetProductRegistry } from './sheet-products'

/** LINE 一則卡片訊息最多 10 張 */
export const SHEET_CATALOG_MAX_CARDS = 10

export interface SheetCatalogSource {
  /** 知識庫裡那份 Google 試算表（來源 id） */
  sourceId: string
  /** 點卡片送哪個模組（商品資訊範本，`C-437`） */
  tapModuleId: string
  /** 自動建的標籤名稱開頭（例：MYFEEL 的「客服 - 」）；沒有＝標籤就叫商品名 */
  tagPrefix?: string
}

/** 這則卡片訊息是不是照試算表排；是的話回設定（欄位沒填齊也回，讓存檔檢查講缺什麼） */
export function readSheetCatalogSource(msg: any): SheetCatalogSource | null {
  const s = msg?.sheetSource
  if (!s || typeof s !== 'object') return null
  const out: SheetCatalogSource = {
    sourceId: String(s.sourceId ?? '').trim(),
    tapModuleId: String(s.tapModuleId ?? '').trim(),
  }
  if (typeof s.tagPrefix === 'string') out.tagPrefix = s.tagPrefix
  return out
}

/** 存檔檢查：照試算表排的卡片訊息只看這兩格（卡片是送出時才產生的）。沒問題回空字串 */
export function sheetCatalogError(msg: any): string {
  const s = readSheetCatalogSource(msg)
  if (!s) return ''
  if (!s.sourceId) return '商品目錄：請選擇要照哪一份試算表排'
  if (!s.tapModuleId) return '商品目錄：請選擇點卡片要送的模組'
  return ''
}

export interface SheetCatalogPlan {
  /** 會出現在目錄上的（照試算表順序、最多 10 張） */
  cards: SheetProduct[]
  /** 勾了、有圖，但第 11 張之後的——⛔ 要講出是哪幾個 */
  overflow: SheetProduct[]
  /** 勾了但還沒有圖的——先不放（不出現空白卡），要講 */
  noImage: SheetProduct[]
}

export function planSheetCatalog(reg: SheetProductRegistry, max = SHEET_CATALOG_MAX_CARDS): SheetCatalogPlan {
  const wanted = Object.values(reg.products)
    .filter(p => p.missingSince === null && p.inCatalog)
    .sort((a, b) => a.order - b.order)
  const withImage = wanted.filter(p => productImage(p))
  return {
    cards: withImage.slice(0, max),
    overflow: withImage.slice(max),
    noImage: wanted.filter(p => !productImage(p)),
  }
}

/** 點卡片帶的「哪一份試算表的哪個商品」（postback 的 `p=`） */
export function sheetProductRef(sourceId: string, productId: string): string {
  return `${sourceId}:${productId}`
}

export function parseSheetProductRef(ref: unknown): { sourceId: string, productId: string } | null {
  const m = String(ref ?? '').match(/^([^:]+):([^:]+)$/)
  return m ? { sourceId: m[1]!, productId: m[2]! } : null
}

/** 照商品清單產生卡片（跟手動做的卡片同一個形狀，後面組 LINE 訊息的程式照舊） */
export function sheetCatalogColumns(source: SheetCatalogSource, reg: SheetProductRegistry): any[] {
  return planSheetCatalog(reg).cards.map(p => ({
    imageUrl: productImage(p)!.url,
    title: '',
    text: '',
    action: {
      type: 'module',
      moduleId: source.tapModuleId,
      product: sheetProductRef(source.sourceId, p.id),
      tagging: p.tagId ? { enabled: true, addTagIds: [p.tagId] } : { enabled: false, addTagIds: [] },
    },
    actions: [],
  }))
}

/** 自動建的標籤叫什麼：開頭＋商品名（截到 50 字：標籤管理、推播挑人的畫面放不下更長的） */
export function sheetProductTagName(prefix: string | undefined, title: string): string {
  return `${prefix ?? ''}${title}`.trim().slice(0, 50)
}
