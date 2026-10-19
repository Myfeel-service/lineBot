import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { getDb } from './firebase'

/**
 * 交易通知信寄送（AWS SES）。
 *
 * 設計原則（與 ezpay 開票、金流一致）：
 *   - **Gated**：EMAIL_FROM + AWS_SES_REGION 都設齊才真的寄；未設 → no-op（只 log）。
 *     這讓「SES 帳號還沒申請 / 網域還沒驗證」的現狀不會壞掉任何流程。
 *   - **永不 throw**：呼叫端多在金流 webhook / 排程對帳的路徑上，寄信失敗**絕不能**
 *     拖累主流程（webhook 回非 200 → 藍新重送 → 重複結算）。所有失敗吞掉、回 { ok:false }。
 *
 * 憑證不放 runtimeConfig：SES SDK 走預設憑證鏈（Amplify 執行角色 / 環境變數），
 * 只需要區域與寄件人。
 */

let cachedClient: SESv2Client | undefined
let cachedRegion: string | undefined

interface EmailConfig {
  from: string
  replyTo: string
  region: string
}

function readConfig(): EmailConfig {
  const c = useRuntimeConfig()
  return {
    from: String(c.emailFrom ?? '').trim(),
    replyTo: String(c.emailReplyTo ?? '').trim(),
    region: String(c.awsSesRegion ?? '').trim(),
  }
}

/** SES 是否設定齊全（寄件人 + 區域）。未齊全時所有寄信會 no-op。 */
export function isEmailConfigured(): boolean {
  const { from, region } = readConfig()
  return !!from && !!region
}

function getClient(region: string): SESv2Client {
  if (!cachedClient || cachedRegion !== region) {
    cachedClient = new SESv2Client({ region })
    cachedRegion = region
  }
  return cachedClient
}

export interface SendEmailInput {
  to: string
  subject: string
  /** HTML 內文（呼叫端負責跳脫動態值） */
  html: string
  /** 純文字 fallback（收件端不支援 HTML 時顯示） */
  text: string
}

export interface SendEmailResult {
  ok: boolean
  /** true = 因未設定 SES 或無收件人而略過（非錯誤） */
  skipped?: boolean
  error?: string
}

/**
 * 寄一封信。未設定 SES 或無收件人 → 略過（skipped）；SES 失敗 → 記 log 並回 error。
 * 這個函式**永不 throw**。
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const to = input.to?.trim()
  if (!to) return { ok: false, skipped: true }

  const cfg = readConfig()
  if (!cfg.from || !cfg.region) {
    console.log('[email] 未設定 SES（EMAIL_FROM / AWS_SES_REGION），略過寄信：', input.subject, '→', to)
    return { ok: false, skipped: true }
  }

  try {
    const ses = getClient(cfg.region)
    await ses.send(new SendEmailCommand({
      FromEmailAddress: cfg.from,
      ...(cfg.replyTo ? { ReplyToAddresses: [cfg.replyTo] } : {}),
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: input.html, Charset: 'UTF-8' },
            Text: { Data: input.text, Charset: 'UTF-8' },
          },
        },
      },
    }))
    await recordDelivery({ ok: true, subject: input.subject })
    return { ok: true }
  }
  catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[email] 寄信失敗：', input.subject, '→', to, msg)
    await recordDelivery({ ok: false, subject: input.subject, error: msg })
    return { ok: false, error: msg }
  }
}

// ── 寄信健康紀錄（`B-50`）────────────────────────────────────────
//
// 為什麼要有：SES 程式與設定齊了，但「寄不寄得出去」以前只有一個證據——08-17 那封收據信。
// 之後權限掉了、寄件網域失效，寄信層照設計吞掉錯誤、金流照常，**沒有任何地方看得到**。
// 所有信都走 sendEmail 這一個出口，所以在這裡記「最近一次寄成功／寄失敗」，超管異常總覽讀它。
// 只記主旨與時間（主旨裡會有帳號名稱，只給超管看），⛔ 不記收件人。

/** 寄信健康紀錄放在哪（跟排程心跳同一個系統狀態 collection）。 */
export const EMAIL_DELIVERY_DOC = { collection: 'cronState', doc: 'email-delivery' } as const

async function recordDelivery(r: { ok: boolean, subject: string, error?: string }): Promise<void> {
  try {
    const data = r.ok
      ? { lastSuccessAt: Date.now(), lastSuccessSubject: r.subject.slice(0, 120) }
      : { lastFailureAt: Date.now(), lastFailureSubject: r.subject.slice(0, 120), lastFailureError: String(r.error ?? '').slice(0, 300) }
    await getDb().collection(EMAIL_DELIVERY_DOC.collection).doc(EMAIL_DELIVERY_DOC.doc).set(data, { merge: true })
  }
  catch (e) {
    // 記不下來不影響寄信結果（信已經寄了／已經失敗了），只是異常總覽會少一筆
    console.warn('[email] 寄信紀錄寫不進去（不影響寄信本身）', (e as Error)?.message)
  }
}

/** 給超管看的寄信狀態：設定齊不齊＋最近一次成功／失敗。寄件人與區域不是機密（信上就看得到）。 */
export interface EmailDeliveryHealth {
  configured: boolean
  from: string
  region: string
  lastSuccessAt: number | null
  lastSuccessSubject: string | null
  lastFailureAt: number | null
  lastFailureSubject: string | null
  lastFailureError: string | null
}

/** 讀寄信狀態。讀不到紀錄會 throw——呼叫端要把「查不到」跟「從沒寄過」分開講。 */
export async function readEmailDeliveryHealth(): Promise<EmailDeliveryHealth> {
  const cfg = readConfig()
  const snap = await getDb().collection(EMAIL_DELIVERY_DOC.collection).doc(EMAIL_DELIVERY_DOC.doc).get()
  const d = (snap.exists ? snap.data() : {}) as Record<string, unknown> | undefined
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null)
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  return {
    configured: !!cfg.from && !!cfg.region,
    from: cfg.from,
    region: cfg.region,
    lastSuccessAt: num(d?.lastSuccessAt),
    lastSuccessSubject: str(d?.lastSuccessSubject),
    lastFailureAt: num(d?.lastFailureAt),
    lastFailureSubject: str(d?.lastFailureSubject),
    lastFailureError: str(d?.lastFailureError),
  }
}
