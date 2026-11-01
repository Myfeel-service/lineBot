import { sheetFieldToken, SHEET_CURRENT_ROW, SHEET_FIELD_IMAGE, SHEET_FIELD_NAME } from './sheet-field'
import { findProductPageHeader, isSheetControlHeader, sheetHeaderKey, SHEET_FAQ_HEADER } from './sheet-products'

/**
 * 「幫我做一份商品資訊範本」（`C-453`④）：照這份試算表的欄名排好一份範本，店家不用自己一格一格插「這個商品」。
 * 以前商品目錄「點卡片送哪個模組」旁的「＋ 新模組」只會建一段固定的字＝每個商品點了收到一樣的內容。
 * 長相跟 10-31 替 MYFEEL 換的那份一樣（`C-439`）：
 *  - 一張商品卡：這個商品的圖、商品名、「您好，」＋每一欄一段（「欄名：值」）、查看商品頁（綠色）、常見問答（文字連結）
 *  - 收尾一句＋快速回覆：看其他商品（回這個目錄）、真人客服——⛔ 快速回覆只能掛在文字訊息上，掛不上卡片
 * 空白的格子那一段不出現、沒網址的按鈕不出現（填法在 `sheet-current-product.ts`），所以每一欄都放、不用挑。
 */
export interface ProductTemplateInput {
  /** 這份試算表的欄名（第一欄商品名不在裡面；開關欄有沒有都可以，這裡會拿掉） */
  headers: readonly string[]
  /** 「看其他商品」回哪個目錄；新的目錄還沒存檔沒有 id＝不放這顆 */
  catalogModuleId?: string
  /** 「真人客服」那顆（`${workspaceId}_live_agent`，每個帳號都有） */
  liveAgentModuleId: string
}

export const PRODUCT_TEMPLATE_NAME = '商品資訊範本'
export const PRODUCT_TEMPLATE_CLOSING = '還有其他問題，也歡迎直接留言問我們。'

const NO_TAG = { enabled: false, addTagIds: [] as string[] }

export function buildProductTemplateMessages(input: ProductTemplateInput): any[] {
  const at = (field: string) => sheetFieldToken({ row: SHEET_CURRENT_ROW, field })
  const headers = input.headers.map(h => String(h ?? '').trim()).filter(h => h && !isSheetControlHeader(h))
  const pageHeader = findProductPageHeader(headers)
  const faqHeader = headers.find(h => sheetHeaderKey(h) === sheetHeaderKey(SHEET_FAQ_HEADER)) ?? null
  // 網址那兩欄做成按鈕，不放進內文（一長串網址放在卡片上只是雜訊）
  const bodyFields = headers.filter(h => h !== pageHeader && h !== faqHeader)
  const text = ['{{displayName}}您好，', ...bodyFields.flatMap(h => ['', `${h}：${at(h)}`])].join('\n')
  const button = (label: string, field: string, style: 'primary' | 'link') => ({
    type: 'uri', label, uri: at(field), text: '', moduleId: '', tagging: NO_TAG, style,
  })
  const quick = (label: string, moduleId: string) => ({
    imageUrl: '', action: { type: 'module', label, text: label, moduleId, tagging: NO_TAG },
  })
  return [
    {
      type: 'flexImageCarousel',
      altText: at(SHEET_FIELD_NAME),
      enableImage: true,
      imageAspectRatio: '16:9',
      columns: [{
        imageUrl: at(SHEET_FIELD_IMAGE),
        title: at(SHEET_FIELD_NAME),
        text,
        action: { type: 'none', uri: '', text: '', label: '', moduleId: '', tagging: NO_TAG },
        actions: [
          ...(pageHeader ? [button('查看商品頁', pageHeader, 'primary')] : []),
          ...(faqHeader ? [button('常見問答', faqHeader, 'link')] : []),
        ],
      }],
    },
    {
      type: 'quickReply',
      text: PRODUCT_TEMPLATE_CLOSING,
      quickReplies: [
        ...(input.catalogModuleId ? [quick('看其他商品', input.catalogModuleId)] : []),
        quick('真人客服', input.liveAgentModuleId),
      ],
    },
  ]
}

/** 名字撞到就加序號（「商品資訊範本 2」）：模組名稱不能重複得一眼分不出 */
export function productTemplateName(existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map(n => String(n ?? '').trim()))
  if (!taken.has(PRODUCT_TEMPLATE_NAME)) return PRODUCT_TEMPLATE_NAME
  for (let i = 2; i < 100; i++) if (!taken.has(`${PRODUCT_TEMPLATE_NAME} ${i}`)) return `${PRODUCT_TEMPLATE_NAME} ${i}`
  return `${PRODUCT_TEMPLATE_NAME} ${Date.now()}`
}
