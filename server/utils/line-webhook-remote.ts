const LINE_MESSAGING = 'https://api.line.me/v2'

/** 比對 Webhook 網址用的正規化：去掉尾斜線與 hash，容忍設定頁貼上時的細微差異 */
export function normalizeWebhookCompareUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    u.hash = ''
    let path = u.pathname.replace(/\/+$/, '') || '/'
    if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1)
    u.pathname = path
    return u.href.replace(/\/$/, '')
  }
  catch {
    return s.replace(/\/+$/, '')
  }
}

export type LineWebhookEndpointInfo = {
  endpoint: string
  active: boolean
}

export type LineWebhookTestResult = {
  success: boolean
  timestamp?: string
  statusCode?: number
  reason?: string
  detail?: string
}

async function readLineJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return { raw: text }
  }
}

/** GET https://api.line.me/v2/bot/channel/webhook/endpoint */
export async function fetchLineWebhookEndpoint(
  channelAccessToken: string,
): Promise<{ ok: true; data: LineWebhookEndpointInfo } | { ok: false; status: number; body: unknown }> {
  const res = await fetch(`${LINE_MESSAGING}/bot/channel/webhook/endpoint`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${channelAccessToken.trim()}`,
      'Content-Type': 'application/json',
    },
  })
  const body = await readLineJson(res)
  if (!res.ok) return { ok: false, status: res.status, body }
  const o = body as Record<string, unknown>
  return {
    ok: true,
    data: {
      endpoint: String(o.endpoint ?? ''),
      active: Boolean(o.active),
    },
  }
}

/** POST https://api.line.me/v2/bot/channel/webhook/test（由 LINE 對已設定 URL 發送測試 POST；每小時約 60 次） */
export async function postLineWebhookTest(
  channelAccessToken: string,
  body: Record<string, unknown> = {},
): Promise<{ ok: true; data: LineWebhookTestResult } | { ok: false; status: number; body: unknown }> {
  const res = await fetch(`${LINE_MESSAGING}/bot/channel/webhook/test`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${channelAccessToken.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const parsed = await readLineJson(res)
  if (!res.ok) return { ok: false, status: res.status, body: parsed }
  const o = parsed as Record<string, unknown>
  return {
    ok: true,
    data: {
      success: Boolean(o.success),
      timestamp: o.timestamp != null ? String(o.timestamp) : undefined,
      statusCode: typeof o.statusCode === 'number' ? o.statusCode : undefined,
      reason: o.reason != null ? String(o.reason) : undefined,
      detail: o.detail != null ? String(o.detail) : undefined,
    },
  }
}
