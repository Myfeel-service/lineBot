import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 超管「寄一封測試信給我」（`B-50`）。⛔ 不真的寄信：寄信那層換成假的。
 * 重點：收件人只能是按的那位超管自己（驗證過的信箱），這支不能被拿來寄信給別人。
 */

let token: Record<string, unknown> = {}
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireSuperAdmin: vi.fn(async () => ({ uid: 'super-1', token })),
  trustedEmail: (t: { email?: string, email_verified?: boolean }) => (t.email_verified === true ? String(t.email).toLowerCase() : null),
}))
vi.mock('~~/server/utils/email', () => ({
  isEmailConfigured: vi.fn(() => true),
  sendEmail: vi.fn(async () => ({ ok: true })),
  readEmailDeliveryHealth: vi.fn(async () => ({ configured: true, from: 'noreply@lineminime.com', region: 'r', lastSuccessAt: 5, lastSuccessSubject: 's', lastFailureAt: null, lastFailureSubject: null, lastFailureError: null })),
}))
vi.mock('~~/server/utils/super-alerts-cache', () => ({ clearSuperAlertsCache: vi.fn() }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (e: { statusCode: number, statusMessage: string }) => Object.assign(new Error(e.statusMessage), e))
vi.stubGlobal('useRuntimeConfig', () => ({ emailFrom: 'noreply@lineminime.com', public: { brandName: 'MiniMe', paymentEnabled: true } }))

const { default: handler } = await import('./test-email.post')
const { sendEmail, isEmailConfigured } = await import('~~/server/utils/email')
const { clearSuperAlertsCache } = await import('~~/server/utils/super-alerts-cache')
const call = (body?: unknown) => (handler as unknown as (e: unknown) => Promise<any>)({ body })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isEmailConfigured).mockReturnValue(true)
  vi.mocked(sendEmail).mockResolvedValue({ ok: true })
  token = { email: 'Service@MyFeel-tw.com', email_verified: true }
})

describe('POST /api/admin/super/test-email', () => {
  it('寄給按的那位超管自己（驗證過的信箱）→ 回最新寄信狀態、清掉總覽快取', async () => {
    const r = await call()
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendEmail).mock.calls[0]![0]).toMatchObject({ to: 'service@myfeel-tw.com', subject: expect.stringContaining('[MiniMe] 寄信測試') })
    expect(r).toMatchObject({ ok: true, to: 'service@myfeel-tw.com', health: { paymentEnabled: true, lastSuccessAt: 5 } })
    expect(clearSuperAlertsCache).toHaveBeenCalled()
  })

  it('🔴 不收任何收件人參數：body 帶別人的信箱也只寄給自己', async () => {
    await call({ to: 'victim@example.com' })
    expect(vi.mocked(sendEmail).mock.calls[0]![0].to).toBe('service@myfeel-tw.com')
  })

  it('信箱沒驗證過 → 400、不寄', async () => {
    token = { email: 'x@example.com', email_verified: false }
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('寄信設定不齊 → 講清楚、不寄', async () => {
    vi.mocked(isEmailConfigured).mockReturnValue(false)
    const r = await call()
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('寄信設定不齊') })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('SES 拒寄 → 原因帶回畫面', async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({ ok: false, error: 'AccessDenied' })
    expect(await call()).toMatchObject({ ok: false, error: 'AccessDenied' })
  })
})
