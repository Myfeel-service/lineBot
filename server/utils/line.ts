import * as line from '@line/bot-sdk'
import { HTTPFetchError } from '@line/bot-sdk'
import { createHmac, timingSafeEqual } from 'crypto'
import { getLineWorkspaceCredentials } from './line-workspace-credentials'

function lineMulticastErrorDetail(err: unknown): string {
  if (err instanceof HTTPFetchError && err.body) return `${err.message} | ${err.body}`
  if (err instanceof Error) return err.message
  return String(err)
}

type MessagingBundle = {
  token: string
  workspaceId: string
  client: line.messagingApi.MessagingApiClient
  blob: line.messagingApi.MessagingApiBlobClient
}

const _messagingByWorkspace = new Map<string, MessagingBundle>()
const _insightByWorkspace = new Map<string, { token: string; client: line.insight.InsightClient }>()

async function getMessagingBundle(workspaceId: string): Promise<MessagingBundle> {
  const wid = String(workspaceId || '').trim()
  if (!wid) throw new Error('workspaceId is required')
  const { channelAccessToken } = await getLineWorkspaceCredentials(wid)
  const token = String(channelAccessToken || '').trim()
  if (!token) throw new Error(`LINE channel access token is not set in Firestore workspaces/${wid}`)

  const current = _messagingByWorkspace.get(wid)
  if (!current || current.token !== token) {
    const next = {
      token,
      workspaceId: wid,
      client: new line.messagingApi.MessagingApiClient({ channelAccessToken: token }),
      blob: new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: token }),
    }
    _messagingByWorkspace.set(wid, next)
    return next
  }
  return current
}

type VerifyLineWebhookSignatureOpts = {
  /** 若已讀過憑證可傳入，避免 webhook 重複打 Firestore／快取邏輯 */
  channelSecret: string
}

/** Verify x-line-signature（憑證來自 Firestore）。`body` 須與請求位元組一致（勿用 JSON.parse 後再 stringify）。 */
export async function verifyLineWebhookSignature(
  body: string | Buffer,
  signature: string,
  opts: VerifyLineWebhookSignatureOpts,
): Promise<boolean> {
  const secret = String(opts.channelSecret || '').trim()
  if (!secret) return false
  const sig = String(signature || '').trim()
  if (!sig) return false
  const hmac = createHmac('sha256', secret)
  if (typeof body === 'string')
    hmac.update(body, 'utf8')
  else
    hmac.update(body)
  const expected = hmac.digest('base64')
  try {
    return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))
  }
  catch {
    return false
  }
}

/** LINE Insight（開封／官方互動統計） */
export async function getInsightClient(workspaceId: string): Promise<line.insight.InsightClient> {
  const wid = String(workspaceId || '').trim()
  if (!wid) throw new Error('workspaceId is required')
  const { channelAccessToken } = await getLineWorkspaceCredentials(wid)
  const token = String(channelAccessToken || '').trim()
  if (!token) throw new Error('LINE channel access token is not set')

  const current = _insightByWorkspace.get(wid)
  if (!current || current.token !== token) {
    const next = {
      token,
      client: new line.insight.InsightClient({ channelAccessToken: token }),
    }
    _insightByWorkspace.set(wid, next)
    return next.client
  }
  return current.client
}

/** Reply to a LINE event's replyToken */
export async function replyMessage(
  replyToken: string,
  messages: line.messagingApi.Message[],
  workspaceId: string,
) {
  const { client } = await getMessagingBundle(workspaceId)
  return client.replyMessage({ replyToken, messages })
}

/**
 * 在 1:1 聊天室顯示「輸入中…」loading 動畫（AI 思考期間的即時回饋）。
 * 動畫會在送出訊息或 loadingSeconds 到期時自動消失；只支援 1:1，群組會被 LINE 忽略。
 * loadingSeconds 須為 5 的倍數（5–60）。
 */
export async function showLoadingAnimation(
  chatId: string,
  workspaceId: string,
  loadingSeconds = 20,
) {
  const { client } = await getMessagingBundle(workspaceId)
  return client.showLoadingAnimation({ chatId, loadingSeconds })
}

/** Push a message to a LINE userId */
export async function pushMessage(
  userId: string,
  messages: line.messagingApi.Message[],
  workspaceId: string,
) {
  const { client } = await getMessagingBundle(workspaceId)
  return client.pushMessage({ to: userId, messages })
}

export type LineMessageContentResult =
  | { ok: true; buffer: Buffer; contentType: string }
  /**
   * expired：LINE 只暫存使用者傳來的檔案一段時間，過期就 404（拿不回來了）。
   * not_ready：影片轉檔中（202），稍後可再試。
   */
  | { ok: false; reason: 'expired' | 'not_ready' | 'too_large' | 'error'; detail?: string }

/**
 * 下載使用者傳來的圖／影／音／檔原始內容（webhook payload 只給 messageId，沒有網址）。
 * 邊收邊算大小、超過 maxBytes 立刻中止，避免一支大影片就把 Lambda 記憶體吃光。
 */
export async function fetchLineMessageContent(
  messageId: string,
  workspaceId: string,
  options?: { maxBytes?: number },
): Promise<LineMessageContentResult> {
  const id = String(messageId || '').trim()
  if (!id) return { ok: false, reason: 'error', detail: 'messageId is required' }
  const maxBytes = Number(options?.maxBytes) > 0 ? Number(options!.maxBytes) : 30 * 1024 * 1024

  try {
    const { blob } = await getMessagingBundle(workspaceId)
    const { httpResponse, body } = await blob.getMessageContentWithHttpInfo(id)
    if (httpResponse.status === 202) return { ok: false, reason: 'not_ready' }
    const contentType = String(httpResponse.headers.get('content-type') || '')
      .split(';')[0]!
      .trim() || 'application/octet-stream'

    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of body as AsyncIterable<unknown>) {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk, 'utf8')
          : Buffer.from(chunk as Uint8Array)
      total += buf.length
      if (total > maxBytes) {
        body.destroy()
        return { ok: false, reason: 'too_large' }
      }
      chunks.push(buf)
    }
    return { ok: true, buffer: Buffer.concat(chunks), contentType }
  }
  catch (err) {
    if (err instanceof HTTPFetchError) {
      if (err.status === 404 || err.status === 410) return { ok: false, reason: 'expired' }
      return { ok: false, reason: 'error', detail: `${err.status} ${err.message}` }
    }
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
}

/** 建立圖文選單並回傳 richMenuId */
export async function createRichMenu(richMenu: line.messagingApi.RichMenuRequest, workspaceId: string) {
  const { client } = await getMessagingBundle(workspaceId)
  const res = await client.createRichMenu(richMenu)
  return res.richMenuId
}

/** 上傳圖片至圖文選單 */
export async function uploadRichMenuImage(
  richMenuId: string,
  imageBuffer: Buffer,
  contentType: 'image/jpeg' | 'image/png',
  workspaceId: string,
) {
  const { blob } = await getMessagingBundle(workspaceId)
  return blob.setRichMenuImage(richMenuId, new Blob([new Uint8Array(imageBuffer)], { type: contentType }))
}

/** 將指定圖文選單設為全體使用者的預設選單 */
export async function setDefaultRichMenu(richMenuId: string, workspaceId: string) {
  const { client } = await getMessagingBundle(workspaceId)
  return client.setDefaultRichMenu(richMenuId)
}

/** 從 LINE 刪除圖文選單 */
export async function deleteLineRichMenu(richMenuId: string, workspaceId: string) {
  const { client } = await getMessagingBundle(workspaceId)
  return client.deleteRichMenu(richMenuId)
}

export type MulticastOptions = {
  /** LINE 彙總單位（最多 1 個），用於查詢開封／官方網址點擊統計 */
  customAggregationUnits?: string[]
}

/**
 * Multicast messages to multiple LINE userIds.
 * LINE API 限制單次最多 500 人，此函式自動分批處理。
 */
export async function multicastMessage(
  userIds: string[],
  messages: line.messagingApi.Message[],
  workspaceId: string,
  options?: MulticastOptions,
): Promise<{ successCount: number; failedIds: string[]; lineAggregationApplied: boolean }> {
  const { client } = await getMessagingBundle(workspaceId)
  const BATCH_SIZE = 500
  let successCount = 0
  const failedIds: string[] = []
  const firstUnit = options?.customAggregationUnits?.[0]
  const units = firstUnit ? [firstUnit] : undefined
  /** 僅當所有批次皆以 customAggregationUnits 成功送出時為 true（任一批改走無彙總重試則 false） */
  let lineAggregationApplied = Boolean(units?.length)

  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batch = userIds.slice(i, i + BATCH_SIZE)
    const sendWithUnits = Boolean(units?.length && lineAggregationApplied)
    try {
      await client.multicast(
        sendWithUnits
          ? { to: batch, messages, customAggregationUnits: units! }
          : { to: batch, messages },
      )
      successCount += batch.length
    }
    catch (err) {
      if (sendWithUnits && units) {
        console.warn(
          `[multicastMessage] batch ${i}~${i + batch.length - 1} 帶 customAggregationUnits 失敗，改為不帶彙總重試：`,
          lineMulticastErrorDetail(err),
        )
        lineAggregationApplied = false
        try {
          await client.multicast({ to: batch, messages })
          successCount += batch.length
        }
        catch (err2) {
          console.error(
            `[multicastMessage] batch ${i}~${i + batch.length - 1} failed:`,
            lineMulticastErrorDetail(err2),
          )
          failedIds.push(...batch)
        }
      }
      else {
        console.error(
          `[multicastMessage] batch ${i}~${i + batch.length - 1} failed:`,
          lineMulticastErrorDetail(err),
        )
        failedIds.push(...batch)
      }
    }
  }

  return { successCount, failedIds, lineAggregationApplied }
}

const LINE_MESSAGING_ORIGIN = 'https://api.line.me/v2'

/**
 * 取得已加官方帳號為好友的 userId 清單（Messaging API GET /bot/followers/ids，分頁）。
 * 用於補齊 Firestore users：僅靠訊息／postback 寫入時，不會包含「加好友後從未互動」的帳號。
 */
export async function fetchAllFollowerUserIds(options?: {
  /** 最多收集幾個 userId（避免極大帳號一次佔滿記憶體） */
  maxIds?: number
  workspaceId: string
}): Promise<{ userIds: string[]; truncated: boolean }> {
  const wid = String(options?.workspaceId || '').trim()
  if (!wid) throw new Error('workspaceId is required')
  const { channelAccessToken } = await getLineWorkspaceCredentials(wid)
  const token = String(channelAccessToken || '').trim()
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set')

  const maxIds = Math.min(Math.max(1, options?.maxIds ?? 80_000), 100_000)
  const all: string[] = []
  let start: string | undefined
  let truncated = false

  while (all.length < maxIds) {
    const url = new URL(`${LINE_MESSAGING_ORIGIN}/bot/followers/ids`)
    url.searchParams.set('limit', '1000')
    if (start) url.searchParams.set('start', start)

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`LINE followers/ids ${res.status}: ${text}`)
    }
    let data: { userIds?: string[]; next?: string }
    try {
      data = JSON.parse(text) as { userIds?: string[]; next?: string }
    }
    catch {
      throw new Error(`LINE followers/ids invalid JSON: ${text.slice(0, 240)}`)
    }

    const ids = data.userIds ?? []
    const room = maxIds - all.length
    if (ids.length > room) {
      all.push(...ids.slice(0, room))
      truncated = true
      break
    }
    all.push(...ids)
    if (!data.next || ids.length === 0) break
    start = data.next
  }

  return { userIds: all, truncated }
}

/** Get user profile */
export async function getUserProfile(userId: string, workspaceId: string) {
  try {
    const { client } = await getMessagingBundle(workspaceId)
    return await client.getProfile(userId)
  }
  catch {
    return null
  }
}

/** 將指定圖文選單連結至使用者 */
export async function linkRichMenuIdToUser(
  userId: string,
  richMenuId: string,
  workspaceId: string,
) {
  const { client } = await getMessagingBundle(workspaceId)
  return client.linkRichMenuIdToUser(userId, richMenuId)
}

/** 建立圖文選單別名（供 LINE 原生 richmenuswitch 瞬間切換） */
export async function createRichMenuAlias(
  richMenuId: string,
  richMenuAliasId: string,
  workspaceId: string,
) {
  const { client } = await getMessagingBundle(workspaceId)
  return client.createRichMenuAlias({ richMenuId, richMenuAliasId })
}

/** 刪除圖文選單別名 */
export async function deleteRichMenuAlias(richMenuAliasId: string, workspaceId: string) {
  const { client } = await getMessagingBundle(workspaceId)
  try {
    return await client.deleteRichMenuAlias(richMenuAliasId)
  }
  catch {
    // Ignore if alias doesn't exist
  }
}

/** 更新圖文選單別名指向新的 richMenuId。
 *  LINE 無直接更新 API，故採刪除後重建。 */
export async function updateRichMenuAlias(
  richMenuId: string,
  richMenuAliasId: string,
  workspaceId: string,
) {
  await deleteRichMenuAlias(richMenuAliasId, workspaceId)
  return createRichMenuAlias(richMenuId, richMenuAliasId, workspaceId)
}

/** 自 LINE 取得圖文選單別名詳情 */
export async function getRichMenuAlias(richMenuAliasId: string, workspaceId: string) {
  const { client } = await getMessagingBundle(workspaceId)
  return client.getRichMenuAlias(richMenuAliasId)
}
