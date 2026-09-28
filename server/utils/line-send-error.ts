/**
 * 把 LINE Messaging API 退件的原因翻成客服看得懂的一句話。
 *
 * 原本 pushMessage 的錯直接往上拋、端點沒接，客服一律只看到「發送失敗」——
 * 但「客人把你封鎖了」「這個月推播額度用完」「訊息太長」的下一步完全不同：
 * 第一種要改用別的管道聯絡、第二種要找老闆升方案、第三種自己拆成兩則就好。
 *
 * 判斷不到是 LINE 的錯就回 null，呼叫端要原封不動把原本的錯往上丟
 * （例如頻道還沒設定好那種 createError，翻成「發送失敗」反而把線索蓋掉）。
 */

/** @line/bot-sdk 的 HTTPFetchError：status 是 HTTP 狀態、body 是 LINE 回的原始 JSON 字串 */
function asLineHttpError(e: unknown): { status: number, body: string } | null {
  if (!e || typeof e !== 'object') return null
  const status = Number((e as { status?: unknown }).status)
  const body = (e as { body?: unknown }).body
  if (!Number.isFinite(status) || status <= 0) return null
  if (typeof body !== 'string') return null
  return { status, body }
}

/**
 * LINE 退件是哪一種（**單一事實來源**，2026-09-27 `C-271`⑭）。
 * 對話頁的「發送失敗」說明（下面那支）與 LINE 通知的送達紀錄（`line-notify-delivery.ts`）都用這一份——
 * ⛔ 兩邊各判一次，哪天 LINE 換了封鎖的字樣，同一個錯誤在兩頁會歸成不同類。
 * 回 null＝不是 LINE 回的 HTTP 錯誤（斷線、頻道沒設定好這類）。
 */
export type LineSendFailureKind = 'blocked' | 'monthlyQuota' | 'rateLimited' | 'tooLong' | 'badRequest' | 'auth' | 'server' | 'other'

export function lineSendFailureKind(e: unknown): LineSendFailureKind | null {
  const err = asLineHttpError(e)
  if (!err) return null
  const detail = err.body.toLowerCase()
  // 封鎖／不是好友：LINE 用同一句話回這兩種情形
  if (detail.includes('blocked') || detail.includes("hasn't added") || detail.includes('has not added')) return 'blocked'
  if (err.status === 429) {
    // 429 有兩種：當月推播額度用完（要升方案）、短時間送太快（等一下就好）
    return detail.includes('monthly limit') || detail.includes('quota') ? 'monthlyQuota' : 'rateLimited'
  }
  if (err.status === 400) {
    return detail.includes('5000') || detail.includes('max length') || detail.includes('length must be') ? 'tooLong' : 'badRequest'
  }
  if (err.status === 401 || err.status === 403) return 'auth'
  if (err.status >= 500) return 'server'
  return 'other'
}

export function describeLineSendFailure(e: unknown): string | null {
  const kind = lineSendFailureKind(e)
  if (!kind) return null
  const err = asLineHttpError(e)!
  switch (kind) {
    // 客服要做的事一樣，所以封鎖與不是好友一起講
    case 'blocked': return '這位客人已封鎖或還沒加入官方帳號，訊息送不出去。'
    case 'monthlyQuota': return '本月推播則數已用完（LINE 官方帳號方案的額度），要等下個月重算或升級方案才能再送。'
    case 'rateLimited': return '送太快被 LINE 暫時擋下來了，請過幾秒再送一次。'
    case 'tooLong': return '訊息太長，LINE 單則上限 5000 字，請拆成兩則送。'
    case 'badRequest': return `LINE 不接受這則訊息的內容${extractLineMessage(err.body)}`
    case 'auth': return 'LINE 頻道憑證失效或權限不足，請到 LINE 設定頁重新設定 Channel access token。'
    case 'server': return 'LINE 伺服器暫時有問題，請稍後再送一次。'
    default: return `發送失敗（LINE 回應 ${err.status}）${extractLineMessage(err.body)}`
  }
}

/** 把 LINE 回的 { "message": "..." } 挑出來附在後面，供客服回報時貼給我們看 */
function extractLineMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown }
    const message = String(parsed?.message ?? '').trim()
    return message ? `：${message}` : ''
  }
  catch {
    return ''
  }
}
