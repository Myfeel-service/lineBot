/**
 * 客服對話頁右半邊（對話區）要不要掛右邊那一欄客人檔案（`D-76`）。
 *
 * 量出來的：1100 寬的螢幕，對話區 620px，客人檔案一欄 320px，訊息只剩 300px——泡泡一行 9～11 個字、
 * 一句話折成 2～4 行。所以對話區不到 800px（＝訊息至少要留 480px）就不掛那一欄，改成按「客人檔案 →」滑出抽屜。
 * 1440 寬（對話區 960）照舊掛著；清單欄可以拖寬，所以吃的是對話區**實際寬度**，不是視窗寬。
 */
export const CUSTOMER_PANEL_MIN_EDITOR_PX = 800

/**
 * @param widthPx  對話區（`.split-editor`）現在的寬度
 * @param previous 上一次的判斷：寬度量到 0（這一刻藏著，例如手機上停在清單那一邊）時維持原值，不要亂翻
 */
export function editorTooNarrowForCustomerColumn(widthPx: number, previous: boolean): boolean {
  if (!(widthPx > 0)) return previous
  return widthPx < CUSTOMER_PANEL_MIN_EDITOR_PX
}
