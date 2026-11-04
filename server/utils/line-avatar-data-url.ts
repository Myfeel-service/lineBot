/**
 * 把官方帳號的 LINE 頭像抓下來轉成 data URL（`C-458`／`D-169` 邀請卡）。
 *
 * 為什麼要伺服器代抓：邀請卡在瀏覽器裡用 canvas 畫，而頭像住在 `profile.line-scdn.net`——
 * 跨網域的圖畫進 canvas 會把畫布「汙染」，之後 `toDataURL()` 直接丟錯，**整張卡存不出來**。
 * 換成 data URL 再畫就沒有這個問題。
 *
 * ⛔ 只抓 LINE 的圖片網域（https、`*.line-scdn.net`），⛔ 不跟轉址：這支是伺服器替人去抓一個網址，
 *    放寬了就是讓人借我們的伺服器去打內網（SSRF）。網址本身來自 LINE `/v2/bot/info`，但閘門不靠「應該是對的」。
 * ⛔ 抓不到一律回 `''`：頭像是加分項，邀請卡沒有頭像照樣能用（畫店名第一個字），⛔ 不可以因為它擋掉整張卡。
 */

const ALLOWED_HOST = /(^|\.)line-scdn\.net$/i
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const AVATAR_TIMEOUT_MS = 5000

export function isAllowedAvatarUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && ALLOWED_HOST.test(u.hostname) && !u.username && !u.password && !u.port
  }
  catch {
    return false
  }
}

export async function fetchLineAvatarDataUrl(
  url: string,
  opts: { fetchImpl?: typeof fetch, maxBytes?: number, timeoutMs?: number } = {},
): Promise<string> {
  if (!url || !isAllowedAvatarUrl(url)) return ''
  const doFetch = opts.fetchImpl ?? fetch
  const maxBytes = opts.maxBytes ?? AVATAR_MAX_BYTES
  try {
    const res = await doFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? AVATAR_TIMEOUT_MS) })
    if (!res.ok) return ''
    const type = String(res.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase()
    if (!ALLOWED_TYPES.has(type)) return ''
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > maxBytes) return ''
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > maxBytes) return ''
    return `data:${type};base64,${buf.toString('base64')}`
  }
  catch {
    return ''
  }
}
