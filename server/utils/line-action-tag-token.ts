import { createHmac, timingSafeEqual } from 'node:crypto'

type UriTagPayload = {
  u: string
  tags: string[]
  uid: string
  exp: number
}

const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

function signPayload(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function createUriTagToken(input: { targetUrl: string; userId: string; tagIds: string[] }, secret: string): string {
  const body: UriTagPayload = {
    u: String(input.targetUrl || '').trim(),
    uid: String(input.userId || '').trim(),
    tags: Array.isArray(input.tagIds) ? input.tagIds.map((v) => String(v || '').trim()).filter(Boolean) : [],
    exp: Date.now() + TOKEN_TTL_MS,
  }
  const payload = JSON.stringify(body)
  const sig = signPayload(payload, secret)
  return Buffer.from(JSON.stringify({ ...body, sig }), 'utf8').toString('base64url')
}

/**
 * 驗簽章。過期的預設當無效；`allowExpired` 時照樣回來、標 `expired: true`。
 *
 * `C-322`（2026-10-15）：推播一人一則送後，貼標連結會躺在客人的聊天紀錄裡好幾週。
 * 過期的連結**簽章仍是我們簽的**＝目標網址不是別人塞的，所以可以帶他去原網址、只是不貼標；
 * ⛔ 以前過期一律回首頁＝兩週前的推播按鈕點了就壞掉。
 */
export function verifyUriTagToken(
  token: string,
  secret: string,
  opts: { allowExpired?: boolean } = {},
): { targetUrl: string; userId: string; tagIds: string[]; expired: boolean } | null {
  if (!token || !secret) return null
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as UriTagPayload & { sig: string }
    if (!parsed?.u || !parsed?.uid || typeof parsed.exp !== 'number' || typeof parsed.sig !== 'string') return null
    const expired = Date.now() > parsed.exp
    if (expired && !opts.allowExpired) return null
    if (!/^https?:\/\//i.test(parsed.u)) return null

    const payload = JSON.stringify({
      u: parsed.u,
      uid: parsed.uid,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      exp: parsed.exp,
    })
    const expected = signPayload(payload, secret)
    const a = Buffer.from(expected)
    const b = Buffer.from(parsed.sig)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null

    return {
      targetUrl: parsed.u,
      userId: parsed.uid,
      tagIds: Array.isArray(parsed.tags) ? parsed.tags.map((v) => String(v || '').trim()).filter(Boolean) : [],
      expired,
    }
  }
  catch {
    return null
  }
}

