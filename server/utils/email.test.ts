import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 寄信出口（`B-50`）：每一封寄成功／寄失敗都要留紀錄，超管異常總覽才看得到「寄信設定壞了」。
 * ⛔ 不真的寄信：SES 整個換成假的。
 */

const sesSend = vi.fn()
vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class { send = sesSend },
  SendEmailCommand: class { constructor(public input: unknown) {} },
}))

const store = new Map<string, Record<string, unknown>>()
const setCalls: Array<{ key: string, data: Record<string, unknown>, opts: unknown }> = []
let failWrites = false
vi.mock('./firebase', () => ({
  getDb: () => ({
    collection: (c: string) => ({
      doc: (id: string) => ({
        async set(data: Record<string, unknown>, opts: unknown) {
          if (failWrites) throw new Error('firestore down')
          setCalls.push({ key: `${c}/${id}`, data, opts })
          store.set(`${c}/${id}`, { ...(store.get(`${c}/${id}`) ?? {}), ...data })
        },
        async get() {
          const d = store.get(`${c}/${id}`)
          return { exists: d !== undefined, data: () => d }
        },
      }),
    }),
  }),
}))

let runtime: Record<string, unknown> = {}
vi.stubGlobal('useRuntimeConfig', () => runtime)

const { sendEmail, readEmailDeliveryHealth, EMAIL_DELIVERY_DOC } = await import('./email')
const KEY = `${EMAIL_DELIVERY_DOC.collection}/${EMAIL_DELIVERY_DOC.doc}`
const MAIL = { to: 'a@example.com', subject: '[MiniMe] 付款成功通知', html: '<p>x</p>', text: 'x' }

beforeEach(() => {
  sesSend.mockReset()
  store.clear()
  setCalls.length = 0
  runtime = { emailFrom: 'noreply@lineminime.com', emailReplyTo: '', awsSesRegion: 'ap-northeast-1' }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('sendEmail 留寄信紀錄（`B-50`）', () => {
  it('寄成功 → 記最近一次成功（時間＋主旨），⛔不記收件人', async () => {
    sesSend.mockResolvedValueOnce({})
    const r = await sendEmail(MAIL)
    expect(r).toEqual({ ok: true })
    expect(store.get(KEY)).toMatchObject({ lastSuccessSubject: MAIL.subject })
    expect(Number(store.get(KEY)?.lastSuccessAt)).toBeGreaterThan(0)
    expect(JSON.stringify(store.get(KEY))).not.toContain('a@example.com')
    expect(setCalls[0]?.opts).toEqual({ merge: true }) // 不能蓋掉另一半（成功／失敗各記各的）
  })

  it('🔴 SES 拒寄 → 照樣不丟錯，但記下最近一次失敗與原因', async () => {
    sesSend.mockRejectedValueOnce(new Error('AccessDenied: not authorized to perform ses:SendEmail'))
    const r = await sendEmail(MAIL)
    expect(r.ok).toBe(false)
    expect(r.skipped).toBeUndefined()
    expect(store.get(KEY)).toMatchObject({ lastFailureSubject: MAIL.subject, lastFailureError: expect.stringContaining('AccessDenied') })
  })

  it('沒設定 SES → 略過、不留紀錄（不是寄失敗）', async () => {
    runtime = { emailFrom: '', awsSesRegion: '' }
    const r = await sendEmail(MAIL)
    expect(r).toEqual({ ok: false, skipped: true })
    expect(sesSend).not.toHaveBeenCalled()
    expect(store.has(KEY)).toBe(false)
  })

  it('紀錄寫不進去也不影響寄信結果（永不丟錯）', async () => {
    sesSend.mockResolvedValueOnce({})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    failWrites = true
    try {
      expect(await sendEmail(MAIL)).toEqual({ ok: true })
    }
    finally {
      failWrites = false
    }
    expect(warn).toHaveBeenCalled()
  })
})

describe('readEmailDeliveryHealth', () => {
  it('設定齊不齊＋最近一次成功／失敗', async () => {
    store.set(KEY, { lastSuccessAt: 1000, lastSuccessSubject: 's', lastFailureAt: 2000, lastFailureError: 'e', lastFailureSubject: 'f' })
    expect(await readEmailDeliveryHealth()).toEqual({
      configured: true,
      from: 'noreply@lineminime.com',
      region: 'ap-northeast-1',
      lastSuccessAt: 1000,
      lastSuccessSubject: 's',
      lastFailureAt: 2000,
      lastFailureSubject: 'f',
      lastFailureError: 'e',
    })
  })

  it('從沒寄過 → 時間都是 null（不是 0）', async () => {
    const h = await readEmailDeliveryHealth()
    expect(h.lastSuccessAt).toBeNull()
    expect(h.lastFailureAt).toBeNull()
  })
})
