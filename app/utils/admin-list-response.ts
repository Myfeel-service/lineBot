/**
 * 後台 list API 的回應信封：有帶 page 參數時回 `{ items, hasMore, … }`，沒帶時直接回陣列
 * （見 server/utils/paginated-collection-list.ts）。
 *
 * 不分頁地整批拿來做比對／檢查的地方（例如「這個關鍵字會不會蓋掉某條腳本」）都要拆這一層，
 * 各自手寫一次很容易漏掉其中一種形狀、然後靜靜地拿到空陣列——而空陣列在檢查邏輯裡
 * 長得就像「沒有東西受影響」，是最難發現的那種錯。
 */
export function unwrapListRows(res: unknown): Array<Record<string, any>> {
  if (Array.isArray(res)) return res as Array<Record<string, any>>
  const items = (res as { items?: unknown } | null)?.items
  return Array.isArray(items) ? (items as Array<Record<string, any>>) : []
}
