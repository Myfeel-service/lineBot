import * as line from '@line/bot-sdk'
import { HTTPFetchError } from '@line/bot-sdk'
import { createHmac, timingSafeEqual } from 'crypto'
import { v5 as uuidv5 } from 'uuid'
import { getLineWorkspaceCredentials } from './line-workspace-credentials'
import { describeLineSendFailure, lineSendFailureKind } from './line-send-error'
import { lineQuotaFromLine, type LineMessageQuota } from '~~/shared/line-quota'

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

const LINE_QUOTA_TIMEOUT_MS = 4000
/**
 * `D-146`：登入後第一頁那一條、每一頁紅條、小幫手都會問，5 分鐘內同一個帳號只問 LINE 一次（同 webhook 那顆檢查）。
 * 推播頁與發送前確認照舊每次現問（剛送完就要看到新的數字）。
 */
const LINE_QUOTA_CACHE_MS = 5 * 60_000

export type LineQuotaRead =
  | { kind: 'ok', quota: LineMessageQuota }
  /** 還沒接 LINE（沒有存取權杖）：沒有則數這回事，畫面不顯示、小幫手也不亮 */
  | { kind: 'unconfigured' }
  /** 問了沒問到（LINE 退件、逾時、格式看不懂）：⛔ 不等於沒事，小幫手要照「這次查不到」講 */
  | { kind: 'error', detail: string }

const _lineQuotaCache = new Map<string, { at: number, read: LineQuotaRead }>()

function rememberLineQuota(wid: string, read: LineQuotaRead): LineQuotaRead {
  _lineQuotaCache.set(wid, { at: Date.now(), read })
  return read
}

/**
 * LINE 這個月還能送幾則（`C-380`，數字的意思見 `shared/line-quota.ts`）：現問、不看快取，問到就順手更新快取。
 * ⛔ 不讓它拖住呼叫它的端點：LINE 慢的時候最多等 4 秒就放棄（回 error）。
 */
export async function readLineMessageQuota(workspaceId: string): Promise<LineQuotaRead> {
  const wid = String(workspaceId || '').trim()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { channelAccessToken } = await getLineWorkspaceCredentials(wid)
    if (!String(channelAccessToken || '').trim()) return rememberLineQuota(wid, { kind: 'unconfigured' })
    const { client } = await getMessagingBundle(wid)
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LINE_QUOTA_TIMEOUT_MS) })
    const res = await Promise.race([
      Promise.all([client.getMessageQuota(), client.getMessageQuotaConsumption()]),
      timeout,
    ])
    if (!res) {
      console.warn(`[getLineMessageQuota] ${wid} LINE 超過 ${LINE_QUOTA_TIMEOUT_MS}ms 沒回，這次不顯示`)
      return { kind: 'error', detail: `LINE 超過 ${LINE_QUOTA_TIMEOUT_MS / 1000} 秒沒回` }
    }
    const q = lineQuotaFromLine(res[0], res[1])
    if (!q) {
      console.warn(`[getLineMessageQuota] ${wid} LINE 回的格式看不懂：`, JSON.stringify(res))
      return { kind: 'error', detail: 'LINE 回的格式看不懂' }
    }
    return rememberLineQuota(wid, { kind: 'ok', quota: q })
  }
  catch (err) {
    const detail = lineMulticastErrorDetail(err)
    console.warn(`[getLineMessageQuota] ${wid} 讀不到 LINE 則數：`, detail)
    return { kind: 'error', detail }
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}

/** 5 分鐘內問過就用上次的。只記「問到了」與「沒接 LINE」；問失敗不記，下一次照問 */
export async function readLineMessageQuotaCached(workspaceId: string, opts?: { skipCache?: boolean }): Promise<LineQuotaRead> {
  const wid = String(workspaceId || '').trim()
  const hit = opts?.skipCache ? null : _lineQuotaCache.get(wid)
  if (hit && Date.now() - hit.at < LINE_QUOTA_CACHE_MS) return hit.read
  return readLineMessageQuota(wid)
}

/** 讀不到（還沒接 LINE、憑證失效、LINE 沒回）回 null，畫面整行不顯示 */
export async function getLineMessageQuota(workspaceId: string): Promise<LineMessageQuota | null> {
  const r = await readLineMessageQuota(workspaceId)
  return r.kind === 'ok' ? r.quota : null
}

export type LineMonthSendBreakdown = {
  /** 群發（我們的推播走這條） */
  multicast: number
  /** 一則一則送的：後台回客人、LINE 通知、試發、活動頁加好友那則、用了客人名字的推播 */
  push: number
  /** 回覆客人剛傳來的那則（AI、自動回應）：LINE 不算則數 */
  reply: number
  /** 統計到哪一天（「10/21」）；這個月還沒有任何一天可以查＝null */
  throughLabel: string | null
  /** 有幾天問不到（LINE 還沒算好、或那天不到 20 則它不給數字） */
  missingDays: number
}

/**
 * 這個月到昨天為止，各種送法各送了幾則（`D-146`：問小幫手「LINE 還剩幾則」時順便講用在哪）。
 * ⚠️ LINE 的統計照**日本時間**切天、隔天才有數字、一天不到 20 則不給數字——所以只算到昨天，問不到的天數照實回。
 * 一天問 3 支（LINE 這幾支每秒 2,000 次上限），一個月最多約 90 次。問不到回 null。
 */
export async function getLineMonthSendBreakdown(workspaceId: string, nowMs: number = Date.now()): Promise<LineMonthSendBreakdown | null> {
  try {
    const { client } = await getMessagingBundle(workspaceId)
    const jstToday = new Date(nowMs + 9 * 3600_000)
    const y = jstToday.getUTCFullYear()
    const m = jstToday.getUTCMonth()
    const p2 = (n: number) => String(n).padStart(2, '0')
    const days = Array.from({ length: jstToday.getUTCDate() - 1 }, (_, i) => `${y}${p2(m + 1)}${p2(i + 1)}`)
    const sum = { multicast: 0, push: 0, reply: 0 }
    let missingDays = 0
    await Promise.all(days.map(async (date) => {
      const [mc, ps, rp] = await Promise.all([
        client.getNumberOfSentMulticastMessages(date),
        client.getNumberOfSentPushMessages(date),
        client.getNumberOfSentReplyMessages(date),
      ])
      if ([mc, ps, rp].some(r => r.status !== 'ready')) missingDays++
      sum.multicast += mc.status === 'ready' ? mc.success ?? 0 : 0
      sum.push += ps.status === 'ready' ? ps.success ?? 0 : 0
      sum.reply += rp.status === 'ready' ? rp.success ?? 0 : 0
    }))
    return { ...sum, throughLabel: days.length ? `${m + 1}/${days.length}` : null, missingDays }
  }
  catch (err) {
    console.warn(`[getLineMonthSendBreakdown] ${workspaceId} 問不到這個月各種送法的則數：`, lineMulticastErrorDetail(err))
    return null
  }
}

/**
 * 送東西被 LINE 擋下「這個月用完了」→ 丟掉快取（`D-146`）：下一次問就是新的，紅色不用等 5 分鐘。
 * ⛔ 不在這裡自己記「用完了」：已送是大約數，而店家可能剛在 LINE 後台加購——以 LINE 回的數字為準。
 */
function forgetLineQuotaOnRejection(err: unknown, workspaceId: string) {
  if (lineSendFailureKind(err) === 'monthlyQuota') _lineQuotaCache.delete(String(workspaceId || '').trim())
}

/** Push a message to a LINE userId */
export async function pushMessage(
  userId: string,
  messages: line.messagingApi.Message[],
  workspaceId: string,
) {
  const { client } = await getMessagingBundle(workspaceId)
  try {
    return await client.pushMessage({ to: userId, messages })
  }
  catch (err) {
    forgetLineQuotaOnRejection(err, workspaceId)
    throw err
  }
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
          forgetLineQuotaOnRejection(err2, workspaceId)
          failedIds.push(...batch)
        }
      }
      else {
        console.error(
          `[multicastMessage] batch ${i}~${i + batch.length - 1} failed:`,
          lineMulticastErrorDetail(err),
        )
        forgetLineQuotaOnRejection(err, workspaceId)
        failedIds.push(...batch)
      }
    }
  }

  return { successCount, failedIds, lineAggregationApplied }
}

/**
 * 不帶彙總單位那一次要換一個重送編號：LINE 說同一個編號重送時內容要一模一樣，
 * 拿掉彙總單位已經是不同的請求了。由原編號推出來（固定的），重來一次時算出來的還是同一個。
 */
const RETRY_KEY_PLAIN_NS = '6f1c3e52-8a4b-4f0e-9d2a-3b7c5e1a9f40'
const PUSH_MAX_ATTEMPTS = 4
const PUSH_DEFAULT_CONCURRENCY = 40

export type PerRecipientPushOptions = {
  /** LINE 彙總單位（最多 1 個），用於查詢開封／官方網址點擊統計 */
  customAggregationUnits?: string[]
  /** 同時送幾位（LINE 推送的上限是每秒 2,000 次） */
  concurrency?: number
  /** 測試用：退避等待 */
  sleep?: (ms: number) => Promise<void>
}

export type PerRecipientPushResult = {
  /** LINE 收下了的人數（含 `alreadySentCount`） */
  successCount: number
  /** 之前那一輪就已經收下的（同一個重送編號 LINE 回 409）：這一輪沒有再送一次 */
  alreadySentCount: number
  failedIds: string[]
  /** 沒送到的人各自的原因（一人一則才拿得到；群發是一批 500 人一起回） */
  failureReasons: Record<string, string>
  /** 每一位都帶著彙總單位送出時才是 true */
  lineAggregationApplied: boolean
  /**
   * 中途整批停下來的原因（本月額度用完、憑證失效這種「下一位也一樣會被退」的錯）。
   * 停下來之後剩下的人**沒有再打 LINE**，一律記成沒送到、原因就是這一句。
   */
  stoppedReason: string | null
}

type PushOutcome = { ok: true, already: boolean } | { ok: false, status: number, detail: string }

/**
 * 一人一則送（`D-118` A，2026-10-15）：內容用了 {{變數}} 的推播，每一位換上自己的資料再送。
 *
 * LINE 群發（multicast）一次送一批、每人內容一樣，沒有「每人換上自己名字」的功能（LINE 自家後台的
 * 一般群發也不能放名字）；有在推播放名字的工具，背後都是一人一則。LINE 照收到的人數算則數，所以費用一樣。
 *
 * ⭐ **每一位帶一個固定的重送編號**（`X-Line-Retry-Key`，呼叫端用「推播＋這位客人」算出來）：
 *    LINE 收下過的編號 24 小時內再送會回 409、不會再送一次。所以送到一半斷掉、看門狗收成失敗、
 *    重設再送時，**已經收到的人不會收到第二則**——群發做不到這件事（一批送出去就是送出去了）。
 * ⚠️ 409 算「收到了」（`alreadySentCount` 另外記），⛔ 不可以當失敗：那會讓他被記成沒收到。
 * ⚠️ 送太快（429）、5xx、連線失敗用同一個編號退避重試；其他 4xx 重試也不會變，直接記失敗。
 * ⛔ **本月額度用完也是 429**（`lineSendFailureKind` 分得出來），那種重試沒用、下一位也一樣：
 *    整批停下來（`stoppedReason`），剩下的人不再打 LINE。不停的話 9 千位每位退避 3 秒半，要等十幾分鐘。
 * ⚠️ 彙總單位跟群發同一套退路：第一位帶著被退回、拿掉就收下 → 之後每一位都不帶（`lineAggregationApplied=false`）。
 * `buildMessages` 送到那一位才組（9 千多位好友時不先把每一份都放進記憶體）。
 */
export async function pushMessagesPerRecipient(
  recipients: Array<{ lineUserId: string, retryKey: string }>,
  buildMessages: (lineUserId: string) => line.messagingApi.Message[],
  workspaceId: string,
  options: PerRecipientPushOptions = {},
): Promise<PerRecipientPushResult> {
  const { client } = await getMessagingBundle(workspaceId)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const firstUnit = options.customAggregationUnits?.[0]
  const units = firstUnit ? [firstUnit] : undefined
  let unitsOk = Boolean(units)
  let stoppedReason: string | null = null

  const sendOne = async (lineUserId: string, retryKey: string, withUnits: boolean): Promise<PushOutcome> => {
    if (stoppedReason) return { ok: false, status: 0, detail: stoppedReason }
    const messages = buildMessages(lineUserId)
    // 只有「本來要帶彙總單位、退回後拿掉」那一次才換編號；本來就沒帶的用原編號
    const key = withUnits || !units ? retryKey : uuidv5(retryKey, RETRY_KEY_PLAIN_NS)
    for (let attempt = 0; ; attempt++) {
      try {
        await client.pushMessage(
          withUnits && units ? { to: lineUserId, messages, customAggregationUnits: units } : { to: lineUserId, messages },
          key,
        )
        return { ok: true, already: false }
      }
      catch (err) {
        const status = err instanceof HTTPFetchError ? err.status : 0
        if (status === 409) return { ok: true, already: true }
        const kind = lineSendFailureKind(err)
        const detail = describeLineSendFailure(err) ?? lineMulticastErrorDetail(err)
        if (kind === 'monthlyQuota' || kind === 'auth') {
          forgetLineQuotaOnRejection(err, workspaceId)
          stoppedReason ??= detail
          return { ok: false, status, detail }
        }
        const retriable = kind === null || kind === 'rateLimited' || kind === 'server'
        if (retriable && attempt < PUSH_MAX_ATTEMPTS - 1) {
          await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250))
          if (stoppedReason) return { ok: false, status: 0, detail: stoppedReason }
          continue
        }
        return { ok: false, status, detail }
      }
    }
  }

  let successCount = 0
  let alreadySentCount = 0
  const failedIds: string[] = []
  const failureReasons: Record<string, string> = {}
  const record = (lineUserId: string, r: PushOutcome) => {
    if (r.ok) {
      successCount += 1
      if (r.already) alreadySentCount += 1
      return
    }
    failedIds.push(lineUserId)
    failureReasons[lineUserId] = `${r.status ? `LINE ${r.status}：` : ''}${r.detail}`.slice(0, 300)
  }

  let queue = recipients
  if (queue.length && unitsOk) {
    const first = queue[0]!
    let r = await sendOne(first.lineUserId, first.retryKey, true)
    if (!r.ok && r.status >= 400 && r.status < 500) {
      const plain = await sendOne(first.lineUserId, first.retryKey, false)
      if (plain.ok) {
        console.warn('[pushMessagesPerRecipient] 帶 customAggregationUnits 被退回、拿掉就收下，之後每一位都不帶：', r.detail)
        unitsOk = false
        r = plain
      }
    }
    record(first.lineUserId, r)
    queue = queue.slice(1)
  }

  let next = 0
  const worker = async () => {
    while (next < queue.length) {
      const r = queue[next++]!
      record(r.lineUserId, await sendOne(r.lineUserId, r.retryKey, unitsOk))
    }
  }
  const concurrency = Math.max(1, options.concurrency ?? PUSH_DEFAULT_CONCURRENCY)
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))

  if (failedIds.length) {
    console.error(`[pushMessagesPerRecipient] ${failedIds.length}/${recipients.length} 位沒送到，例：`, failureReasons[failedIds[0]!])
  }
  if (stoppedReason) console.error(`[pushMessagesPerRecipient] 整批停下來：${stoppedReason}`)
  return { successCount, alreadySentCount, failedIds, failureReasons, lineAggregationApplied: unitsOk, stoppedReason }
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
