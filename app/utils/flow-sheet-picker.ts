import type { InjectionKey, Ref } from 'vue'
import type { SheetFieldRef, SheetLabelRegistry } from '~~/shared/sheet-field'

/**
 * 機器人模組「帶出試算表上的一格」（`C-423`）：模組頁提供，插入選單（`FlowVariableInset`）跟預覽來拿。
 * 只有模組頁 provide——別的頁（推播、客服預存…）送出端不換這種標記，插入選單就不會出現這一項。
 */
export interface SheetPickerSource {
  id: string
  name: string
  /** null＝上線前建、還沒再同步過，還不知道有哪幾欄 */
  headers: string[] | null
  rows: Array<{ title: string, values: Record<string, string> }>
}

export interface FlowSheetPicker {
  sources: Ref<SheetPickerSource[] | null>
  loading: Ref<boolean>
  error: Ref<string>
  reload: (fresh?: boolean) => Promise<void>
}

export const FLOW_SHEET_PICKER_KEY: InjectionKey<FlowSheetPicker> = Symbol('flow-sheet-picker')

/**
 * 膠囊短名的對照（`C-428`）：模組頁照挑得到的每一格建一份，輸入框（`VariableTextField`）跟插入選單共用。
 * 沒有 provide（別的頁、或試算表還沒讀到）＝null，膠囊照舊畫全名。
 */
export const SHEET_LABELS_KEY: InjectionKey<Ref<SheetLabelRegistry | null>> = Symbol('sheet-labels')

/**
 * 商品資訊範本（`C-437`）：這個模組用到了「這個商品」的格子，按鈕網址可以選「這個商品的網址」。
 * `urlFields`＝試算表上寫著網址的那幾欄（「商品頁面」「常見問答頁」），按鈕編輯器（`FlowActionEditor`）列出來給挑。
 * 只有模組頁 provide；沒用到「這個商品」＝`enabled` false，按鈕編輯器照舊。
 */
export interface FlowCurrentProduct {
  enabled: Ref<boolean>
  urlFields: Ref<string[]>
}

export const FLOW_CURRENT_PRODUCT_KEY: InjectionKey<FlowCurrentProduct> = Symbol('flow-current-product')

/**
 * 試算表上找不到的那幾格（`C-449`）：模組清單寫「到貨日這一欄找不到了」，點進來那顆膠囊卻長得跟正常的一樣——
 * 輸入框照這份把它畫成紅色。值是 `sheetRefKey`。只有模組頁 provide；沒有＝照舊。
 */
export const SHEET_MISSING_KEY: InjectionKey<Ref<ReadonlySet<string>>> = Symbol('sheet-missing')

/** 一格的比對鍵（列＋欄；不比存的字串，編碼寫法不同也認得） */
export function sheetRefKey(ref: SheetFieldRef): string {
  return `${ref.row}\u0000${ref.field}`
}
