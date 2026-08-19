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

export type LineBotInfo = {
  /** 官方帳號顯示名稱（拿來回顯「這把鑰匙是『○○』的」） */
  displayName: string
  /** @xxxx 形式的 ID */
  basicId: string
  userId: string
}

/**
 * GET https://api.line.me/v2/bot/info —— 用一把 Channel Access Token 問「你是誰」。
 * 用途是在**存檔之前**驗鑰匙真假：只驗長度的話，貼到別家帳號的鑰匙、或已經被重發作廢的舊鑰匙，
 * 都會顯示「收到 ✓」，一路到兩步之後的接線檢查才爆，那時人已經想不到要回頭改鑰匙。
 * 免費、不佔 webhook 測試次數。
 */
export async function fetchLineBotInfo(
  channelAccessToken: string,
): Promise<{ ok: true; data: LineBotInfo } | { ok: false; status: number; body: unknown }> {
  const res = await fetch(`${LINE_MESSAGING}/bot/info`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${channelAccessToken.trim()}` },
  })
  const body = await readLineJson(res)
  if (!res.ok) return { ok: false, status: res.status, body }
  const o = body as Record<string, unknown>
  return {
    ok: true,
    data: {
      displayName: String(o.displayName ?? ''),
      basicId: String(o.basicId ?? ''),
      userId: String(o.userId ?? ''),
    },
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
