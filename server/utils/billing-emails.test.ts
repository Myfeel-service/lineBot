import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 帳務信「寄成功才記寄過」（`B-49`）＋扣款失敗信寫明日期、已降回免費信（`B-16`）。
 *
 * 🔴 B-49 的病：續扣提醒、額度信、綁卡提醒寄完就無條件記「這期寄過」，而寄信那層永不丟錯——
 *    SES 權限掉了，每一封都被記成寄過，之後再也不會重寄。
 * ⛔ 不真的寄信：寄信那層（./email）整個換成假的，由每個測試決定這次寄成功還失敗。
 */

vi.mock('./email', () => ({ sendEmail: vi.fn(), isEmailConfigured: vi.fn(() => true) }))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./ai-usage', () => ({ getQuotaAnswered: vi.fn(async () => 0) }))
// 這兩支只要常數；真的 import 會連帶拉進 LINE／金流一大串模組
vi.mock('./workspace-alerts', () => ({ RENEWAL_BIND_WINDOW_MS: 45 * 24 * 60 * 60 * 1000 }))
vi.mock('./payment', () => ({ PAYMENT_ORDERS_COLLECTION: 'paymentOrders' }))

vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: 'https://lineminime.com', public: { brandName: 'MiniMe' } }))

const { sendEmail, isEmailConfigured } = await import('./email')
const { getQuotaAnswered } = await import('./ai-usage')
const { sendDueBillingEmails, sendChargeFailedNotification } = await import('./billing-emails')
const { EMAIL_MAX_ATTEMPTS, EMAIL_RETRY_COOLDOWN_MS } = await import('~~/shared/billing/email-retry')
import type { WorkspaceSubscription } from '~~/shared/billing/plans'

const mockSend = vi.mocked(sendEmail)
const OK = { ok: true }
const FAIL = { ok: false, error: 'AccessDenied: not authorized to perform ses:SendEmail' }

// 2026-10-18 09:00 台北（UTC 01:00）
const NOW = new Date(Date.UTC(2026, 9, 18, 1, 0, 0))
const later = (ms: number) => new Date(NOW.getTime() + ms)

/** 深拷貝但保留函式／Date（訂單的 createdAt 是有 toMillis() 的物件） */
function clone(v: any): any {
  if (v == null || typeof v !== 'object' || v instanceof Date) return v
  if (Array.isArray(v)) return v.map(clone)
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'function' ? x : clone(x)]))
}

/** 真 Firestore 的 update 把 'a.b' 當巢狀路徑（只改那一格）——程式靠這個避免整包覆寫，mock 要照做 */
function applyUpdate(target: any, data: Record<string, any>): any {
  const out = clone(target ?? {})
  for (const [key, value] of Object.entries(data)) {
    const parts = key.split('.')
    let node = out
    for (const p of parts.slice(0, -1)) {
      node[p] = { ...(node[p] ?? {}) }
      node = node[p]
    }
    node[parts[parts.length - 1]!] = value
  }
  return out
}

const get = (o: any, path: string) => path.split('.').reduce((x, p) => x?.[p], o)
function match(v: unknown, op: string, want: unknown): boolean {
  if (op === '==') return v === want
  if (v == null) return false
  if (op === '>=') return (v as string) >= (want as string)
  if (op === '<=') return (v as string) <= (want as string)
  if (op === '<') return (v as string) < (want as string)
  if (op === '>') return (v as string) > (want as string)
  throw new Error(`op ${op}`)
}

function makeDb(initial: Record<string, any>) {
  const store = new Map<string, any>(Object.entries(initial).map(([k, v]) => [k, clone(v)]))
  const docRef = (c: string, id: string) => ({
    id,
    async get() {
      const d = store.get(`${c}/${id}`)
      return { exists: d !== undefined, id, data: () => d }
    },
    async update(data: Record<string, any>) {
      store.set(`${c}/${id}`, applyUpdate(store.get(`${c}/${id}`), data))
    },
  })
  const query = (c: string, filters: Array<[string, string, unknown]>): any => ({
    where: (f: string, op: string, v: unknown) => query(c, [...filters, [f, op, v]]),
    limit: () => query(c, filters),
    async get() {
      const docs = [...store.entries()]
        .filter(([k]) => k.startsWith(`${c}/`))
        .filter(([, v]) => filters.every(([f, op, want]) => match(get(v, f), op, want)))
        .map(([k, v]) => {
          const id = k.slice(c.length + 1)
          return { id, data: () => v, ref: docRef(c, id) }
        })
      return { docs, size: docs.length, empty: docs.length === 0 }
    },
  })
  return {
    store,
    sub: (wid: string): WorkspaceSubscription => store.get(`workspaces/${wid}`)?.subscription,
    collection: (c: string) => ({ doc: (id: string) => docRef(c, id), where: query(c, []).where, limit: () => query(c, []) }),
  }
}

const ORG = { 'organizations/o1': { ownerEmail: 'owner@example.com' } }

/** 10/20 自動續扣、還沒到（續扣提醒的對象） */
function renewingSub(over: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription {
  return {
    planId: 'lite', status: 'active', currentPeriodStart: '2026-09-21', currentPeriodEnd: '2026-10-20', anchorDay: 21,
    autoRenew: true, payuniCardToken: 'HASH1', payuniCardLast4: '1234', ...over,
  }
}

/** 10/16 那期扣款失敗、還在寬限期（10/19 是最後一天） */
function failedSub(over: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription {
  return {
    planId: 'lite', status: 'past_due', currentPeriodStart: '2026-10-16', currentPeriodEnd: '2026-11-15', anchorDay: 16,
    autoRenew: true, payuniCardToken: 'HASH1', chargePeriodStart: '2026-10-16', chargeAttempts: 1,
    lastChargeDate: '2026-10-16', lastChargeError: '授權失敗', ...over,
  }
}

const ws = (subscription: WorkspaceSubscription, over: Record<string, unknown> = {}) =>
  ({ name: '小福商店', organizationId: 'o1', subscription, ...over })

beforeEach(() => {
  mockSend.mockReset()
  vi.mocked(isEmailConfigured).mockReturnValue(true)
  vi.mocked(getQuotaAnswered).mockResolvedValue(0)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('續扣前提醒（`B-49`）', () => {
  it('寄成功 → 記「這期寄過」', async () => {
    const db = makeDb({ 'workspaces/ws1': ws(renewingSub()), ...ORG })
    mockSend.mockResolvedValueOnce(OK)
    const r = await sendDueBillingEmails(NOW, db as any)
    expect(r.renewalReminders).toBe(1)
    expect(db.sub('ws1').renewalReminderSentFor).toBe('2026-10-20')
    expect(mockSend.mock.calls[0]![0].to).toBe('owner@example.com')
  })

  it('🔴 寄失敗 → **不記**寄過，只記試過第 1 次（以前照樣記成寄過、再也不重寄）', async () => {
    const db = makeDb({ 'workspaces/ws1': ws(renewingSub()), ...ORG })
    mockSend.mockResolvedValueOnce(FAIL)
    const r = await sendDueBillingEmails(NOW, db as any)
    expect(r).toMatchObject({ renewalReminders: 0, failed: 1 })
    expect(db.sub('ws1').renewalReminderSentFor).toBeUndefined()
    expect(db.sub('ws1').emailAttempts?.renewal).toEqual({ key: '2026-10-20', attempts: 1, lastAttemptAt: NOW.getTime() })
  })

  it('🔴 寄失敗之後：10 分鐘後下一輪不重寄（冷卻）；3 小時後再試、寄成功才記寄過', async () => {
    const db = makeDb({ 'workspaces/ws1': ws(renewingSub()), ...ORG })
    mockSend.mockResolvedValueOnce(FAIL)
    await sendDueBillingEmails(NOW, db as any)

    await sendDueBillingEmails(later(10 * 60_000), db as any)
    expect(mockSend).toHaveBeenCalledTimes(1)

    mockSend.mockResolvedValueOnce(OK)
    const r = await sendDueBillingEmails(later(EMAIL_RETRY_COOLDOWN_MS), db as any)
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(r.renewalReminders).toBe(1)
    expect(db.sub('ws1').renewalReminderSentFor).toBe('2026-10-20')
  })

  it('🔴 一直寄失敗 → 試滿上限就停（不無限重寄）', async () => {
    const db = makeDb({ 'workspaces/ws1': ws(renewingSub()), ...ORG })
    mockSend.mockResolvedValue(FAIL)
    for (let i = 0; i < EMAIL_MAX_ATTEMPTS + 3; i++)
      await sendDueBillingEmails(later(i * EMAIL_RETRY_COOLDOWN_MS), db as any)
    expect(mockSend).toHaveBeenCalledTimes(EMAIL_MAX_ATTEMPTS)
    expect(db.sub('ws1').emailAttempts?.renewal?.attempts).toBe(EMAIL_MAX_ATTEMPTS)
    expect(db.sub('ws1').renewalReminderSentFor).toBeUndefined()
  })

  it('沒有帳務信箱 → 記寄過、不寄（寄不了，不必每 10 分鐘重算；同改版前）', async () => {
    const db = makeDb({ 'workspaces/ws1': ws(renewingSub()), 'organizations/o1': {} })
    await sendDueBillingEmails(NOW, db as any)
    expect(mockSend).not.toHaveBeenCalled()
    expect(db.sub('ws1').renewalReminderSentFor).toBe('2026-10-20')
  })

  it('SES 沒設定 → 整段不跑、什麼都不記', async () => {
    vi.mocked(isEmailConfigured).mockReturnValue(false)
    const db = makeDb({ 'workspaces/ws1': ws(renewingSub()), ...ORG })
    const r = await sendDueBillingEmails(NOW, db as any)
    expect(r).toEqual({ renewalReminders: 0, quotaNotices: 0, rebindNotices: 0, chargeFailedNotices: 0, downgradeNotices: 0, failed: 0 })
    expect(db.sub('ws1').renewalReminderSentFor).toBeUndefined()
  })
})

describe('額度信（`B-49`）', () => {
  const freeSub: WorkspaceSubscription = { planId: 'free', status: 'active', currentPeriodStart: '2026-10-10', currentPeriodEnd: '2026-11-09', anchorDay: 10 }

  it('🔴 寄失敗 → 不記寄過；之後寄成功才記', async () => {
    vi.mocked(getQuotaAnswered).mockResolvedValue(50) // 免費方案 50 則用完
    const db = makeDb({ 'workspaces/ws1': ws(freeSub), ...ORG })
    mockSend.mockResolvedValueOnce(FAIL)
    await sendDueBillingEmails(NOW, db as any)
    expect(db.sub('ws1').quotaEmailSentFor).toBeUndefined()
    expect(db.sub('ws1').emailAttempts?.quota).toMatchObject({ key: '2026-10-10:over', attempts: 1 })

    mockSend.mockResolvedValueOnce(OK)
    await sendDueBillingEmails(later(EMAIL_RETRY_COOLDOWN_MS), db as any)
    expect(db.sub('ws1').quotaEmailSentFor).toBe('2026-10-10:over')
  })
})

describe('綁卡提醒（`B-49`）', () => {
  const order = {
    status: 'paid', kind: 'period_first', cardBound: false, workspaceId: 'ws1', planId: 'lite',
    createdAt: { toMillis: () => NOW.getTime() - 24 * 3600_000 },
  }

  it('🔴 寄失敗 → 訂單上不記寄過、只記試過幾次；之後寄成功才記', async () => {
    const db = makeDb({ 'workspaces/ws1': ws({ planId: 'lite', status: 'active', currentPeriodStart: '2026-10-17', currentPeriodEnd: '2026-11-16' }), 'paymentOrders/NP1': order, ...ORG })
    mockSend.mockResolvedValueOnce(FAIL)
    await sendDueBillingEmails(NOW, db as any)
    expect(db.store.get('paymentOrders/NP1').rebindEmailSentAt).toBeUndefined()
    expect(db.store.get('paymentOrders/NP1').rebindEmailAttempt).toMatchObject({ key: 'NP1', attempts: 1 })

    mockSend.mockResolvedValueOnce(OK)
    const r = await sendDueBillingEmails(later(EMAIL_RETRY_COOLDOWN_MS), db as any)
    expect(r.rebindNotices).toBe(1)
    expect(db.store.get('paymentOrders/NP1').rebindEmailSentAt).toBeTruthy()
  })
})

describe('扣款失敗信（`B-49`＋`B-16`）', () => {
  it('🔴 `B-16`：信裡寫明哪天前沒扣到、哪天起降回免費（跟寬限期同一把尺）', async () => {
    const db = makeDb({ 'workspaces/ws1': ws(failedSub()), ...ORG })
    mockSend.mockResolvedValueOnce(OK)
    expect(await sendChargeFailedNotification({ workspaceId: 'ws1', planId: 'lite', periodStart: '2026-10-16' }, db as any, NOW)).toBe('sent')
    const mail = mockSend.mock.calls[0]![0]
    expect(mail.subject).toContain('10 月 19 日前')
    expect(mail.text).toContain('到 10 月 19 日還沒扣款成功，10 月 20 日起會降回免費方案')
    expect(db.sub('ws1').chargeFailedEmailSentFor).toBe('2026-10-16')
  })

  it('🔴 第一次失敗那封寄不出去 → 不記寄過；每日對帳補寄，寄成功才記', async () => {
    const db = makeDb({ 'workspaces/ws1': ws(failedSub()), ...ORG })
    mockSend.mockResolvedValueOnce(FAIL)
    expect(await sendChargeFailedNotification({ workspaceId: 'ws1', planId: 'lite', periodStart: '2026-10-16' }, db as any, NOW)).toBe('failed')
    expect(db.sub('ws1').chargeFailedEmailSentFor).toBeUndefined()
    expect(db.sub('ws1').emailAttempts?.chargeFailed).toMatchObject({ key: '2026-10-16', attempts: 1 })

    // 冷卻中：對帳那輪不補
    await sendDueBillingEmails(later(10 * 60_000), db as any)
    expect(mockSend).toHaveBeenCalledTimes(1)

    mockSend.mockResolvedValueOnce(OK)
    const r = await sendDueBillingEmails(later(EMAIL_RETRY_COOLDOWN_MS), db as any)
    expect(r.chargeFailedNotices).toBe(1)
    expect(db.sub('ws1').chargeFailedEmailSentFor).toBe('2026-10-16')
  })

  it('已寄過的不重寄；還在等結果（沒有失敗原因）的不寄；寬限期過了的不寄（改寄已降回免費）', async () => {
    const db = makeDb({
      'workspaces/sent': ws(failedSub({ chargeFailedEmailSentFor: '2026-10-16' })),
      'workspaces/waiting': ws(failedSub({ lastChargeError: null })),
      'workspaces/expired': ws(failedSub({ currentPeriodStart: '2026-10-10', chargePeriodStart: '2026-10-10', currentPeriodEnd: '2026-11-09' })),
      ...ORG,
    })
    await sendDueBillingEmails(NOW, db as any)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('沒有帳務信箱 → 記成處理完、但標「沒有信箱可寄」（超管清單分得出來）', async () => {
    const db = makeDb({ 'workspaces/ws1': ws(failedSub()), 'organizations/o1': {} })
    expect(await sendChargeFailedNotification({ workspaceId: 'ws1', planId: 'lite', periodStart: '2026-10-16' }, db as any, NOW)).toBe('no_recipient')
    expect(db.sub('ws1').chargeFailedEmailSentFor).toBe('2026-10-16')
    expect(db.sub('ws1').chargeFailedEmailNoRecipientFor).toBe('2026-10-16')
  })
})

describe('已降回免費信（`B-16`）', () => {
  const downgraded = (over: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription => ({
    planId: 'free', status: 'active', currentPeriodStart: '2026-10-16', currentPeriodEnd: '2026-11-15', anchorDay: 16,
    autoRenew: false, lastChargeError: '授權失敗',
    nonPaymentDowngrade: { fromPlanId: 'starter', on: '2026-10-18', emailSent: false },
    ...over,
  })

  it('降級記號在 → 寄一封：哪天、從哪個方案降下來、免費方案每期幾則；寄成功才標寄過', async () => {
    const db = makeDb({ 'workspaces/ws1': ws(downgraded()), ...ORG })
    mockSend.mockResolvedValueOnce(OK)
    const r = await sendDueBillingEmails(NOW, db as any)
    expect(r.downgradeNotices).toBe(1)
    const mail = mockSend.mock.calls[0]![0]
    expect(mail.subject).toBe('[MiniMe] 「小福商店」已降回免費方案')
    expect(mail.text).toContain('10 月 18 日起已降回免費方案')
    expect(mail.text).toContain('每期有 50 則 AI 回覆')
    expect(db.sub('ws1').nonPaymentDowngrade).toEqual({ fromPlanId: 'starter', on: '2026-10-18', emailSent: true })
  })

  it('🔴 寄失敗 → 記號維持「還沒寄」，冷卻過再試', async () => {
    const db = makeDb({ 'workspaces/ws1': ws(downgraded()), ...ORG })
    mockSend.mockResolvedValueOnce(FAIL)
    await sendDueBillingEmails(NOW, db as any)
    expect(db.sub('ws1').nonPaymentDowngrade?.emailSent).toBe(false)
    expect(db.sub('ws1').emailAttempts?.downgrade).toMatchObject({ key: '2026-10-18', attempts: 1 })

    mockSend.mockResolvedValueOnce(OK)
    await sendDueBillingEmails(later(EMAIL_RETRY_COOLDOWN_MS), db as any)
    expect(db.sub('ws1').nonPaymentDowngrade?.emailSent).toBe(true)
  })

  it('降級之後又付了款（方案已不是免費）→ 不寄，直接收掉記號', async () => {
    const db = makeDb({ 'workspaces/ws1': ws(downgraded({ planId: 'starter' })), ...ORG })
    await sendDueBillingEmails(NOW, db as any)
    expect(mockSend).not.toHaveBeenCalled()
    expect(db.sub('ws1').nonPaymentDowngrade?.emailSent).toBe(true)
  })
})
