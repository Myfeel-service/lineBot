/**
 * 活動頁（LIFF Endpoint）路徑的唯一來源。
 *
 * 開通精靈教的、設定頁建議的、健康檢查驗的（liff-endpoint-remote／liff-endpoint-check）、
 * 活動連結組的（lead-campaign-published-url）必須是同一串——之前七處各自寫死
 * `/liff/lead`，只靠註解對齊；哪天路徑要遷移（STATUS A-5），改一漏六就會變成
 * 「精靈教舊網址、健康檢查照新口徑亮紅」，正是 2026-08-07 換網域災情的形狀。
 */
export const LEAD_PATH = '/liff/lead'

/** 組完整 Endpoint URL；base 空字串時回空字串（呼叫端自己決定兜底或不顯示） */
export function leadEndpointUrl(base: string): string {
  const b = String(base || '').trim().replace(/\/$/, '')
  return b ? `${b}${LEAD_PATH}` : ''
}
