/**
 * 出錯時要講的那一句（`C-308`⑩）。
 *
 * 為什麼要有：知識庫資料頁 23 個地方寫 `err?.statusMessage || '還原失敗'`——但 `err.statusMessage`
 * 是 **HTTP 狀態那一行**（正式站實測只拿得到英文「Not Found」，HTTP/2 下多半是空的），伺服器講的中文原因
 * （「AI 知識量滿了」「這張卡在回收桶裡」）在 `err.data.statusMessage`。結果店家只看得到「還原失敗」，
 * 照提示「再按一次」，每次都是同一個錯。
 *
 * 規則（有測試守著）：
 *  · 依序找 `data.statusMessage` → `data.message` → （不是 HTTP 錯誤時）`err.message`；
 *  · ⛔ 一律不用 `err.statusMessage`（HTTP 那一行）與 HTTP 錯誤的 `err.message`
 *    （長得像「[POST] "/api/…": 404 Not Found」）；
 *  · 只收**有中文**的句子：伺服器少數地方還丟英文的開發用訊息（「chunk not found」「sourceId required」），
 *    那種丟給沒受過訓練的店家只會更看不懂——講不出原因就退回呼叫端給的那句。
 */

import { isAiBudgetErrorLike } from '~~/shared/ai-budget'

/** 有沒有中日韓文字（我們自己寫給店家看的句子一定有；英文的開發訊息、HTTP 狀態都沒有） */
const CJK = /[㐀-鿿豈-﫿]/

/** 是不是一次 HTTP 請求的錯（$fetch／ofetch 的 FetchError）：這種錯的 message 是網址＋狀態碼，不能給人看 */
function isHttpError(err: any): boolean {
  if (!err || typeof err !== 'object') return false
  return err.name === 'FetchError'
    || 'response' in err
    || 'request' in err
    || typeof err.statusCode === 'number'
    || typeof err.status === 'number'
}

function pick(v: unknown): string {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  return s && CJK.test(s) ? s.slice(0, 300) : ''
}

/** 伺服器給的原因（中文）；講不出原因就回 fallback */
export function apiErrorText(err: unknown, fallback: string): string {
  const e = err as any
  return pick(e?.data?.statusMessage)
    || pick(e?.data?.message)
    || (isHttpError(e) ? '' : pick(e?.message))
    || fallback
}

/** HTTP 狀態碼；沒有回應（斷線、閘道沒接上）是 0 */
export function apiErrorStatus(err: unknown): number {
  const e = err as any
  return Number(e?.statusCode ?? e?.status ?? e?.response?.status ?? e?.data?.statusCode ?? 0) || 0
}

/**
 * 「再按一次」有沒有用。
 * 4xx（空間滿了、沒有權限、那一份已經不在了、內容不合格）＝伺服器看過、拒絕了：再按一百次都一樣，
 * ⛔ 這種錯後面不可以接「可以直接再按一次」。斷線、逾時（408）、太頻繁（429）、5xx 才值得重試。
 * 不是 HTTP 的錯（自己丟的、輪詢裡的）不知道，當成值得重試（呼叫端原本就這樣講）。
 * ⛔ 每月 AI 用量上限（`C-413`）也是 429，但要等到下個月 1 號（`C-414`）：接「再按一次」等於叫他白按到月底。
 */
export function isRetryableError(err: unknown): boolean {
  if (isAiBudgetErrorLike(err)) return false
  const status = apiErrorStatus(err)
  if (status === 408 || status === 429) return true
  return !(status >= 400 && status < 500)
}
