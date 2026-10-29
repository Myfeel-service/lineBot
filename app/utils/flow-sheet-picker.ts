import type { InjectionKey, Ref } from 'vue'
import type { SheetLabelRegistry } from '~~/shared/sheet-field'

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
