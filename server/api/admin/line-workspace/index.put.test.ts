import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 存 LINE 憑證這支端點的把關（`D-18`）。
 *
 * 釘住的是「寫進去之前就要擋」：同一個官方帳號被兩個工作區綁著時，客人的訊息會整批
 * 進到另一邊，這邊看起來一切正常卻一則都收不到——事後幾乎查不出來，所以只有在
 * **寫入的當下**攔得住。
 */

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__delete__' },
}))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: 'wsB' })),
}))
vi.mock('~~/server/utils/line-workspace-credentials', () => ({
  invalidateLineWorkspaceCredentialsCache: vi.fn(),
}))
vi.mock('~~/server/utils/line-webhook-remote', () => ({
  fetchLineWebhookEndpoint: vi.fn(),
  postLineWebhookTest: vi.fn(),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/line-channel-binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~~/server/utils/line-channel-binding')>()),
  checkChannelBindingConflict: vi.fn(),
  rememberChannelBinding: vi.fn(),
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

let body: Record<string, unknown> = {}
vi.stubGlobal('readBody', async () => body)

const { default: handler } = await import('./index.put')
const { getDb } = await import('~~/server/utils/firebase')
const { checkChannelBindingConflict, rememberChannelBinding } = await import('~~/server/utils/line-channel-binding')

const { writeAuditLog } = await import('~~/server/utils/audit-log')

const setSpy = vi.fn(async (..._args: unknown[]) => {})
const deleteSpy = vi.fn(async () => {})
function stubDb(existing: Record<string, unknown> | null = { name: '舊名字' }) {
  vi.mocked(getDb).mockReturnValue({
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: existing != null, data: () => existing }),
        set: setSpy,
        delete: deleteSpy,
      }),
    }),
  } as never)
}

const call = () => (handler as unknown as (e: unknown) => Promise<unknown>)({})

beforeEach(() => {
  vi.clearAllMocks()
  setSpy.mockClear()
  deleteSpy.mockClear()
  stubDb()
  body = { channelAccessToken: 'a'.repeat(40) }
  vi.mocked(checkChannelBindingConflict).mockResolvedValue({ identity: { kind: 'unknown' }, conflicts: [] })
})

describe('PUT /api/admin/line-workspace', () => {
  it('🔴 這個官方帳號已被別的工作區接走 → 擋下來，而且一個字都不寫進去', async () => {
    vi.mocked(checkChannelBindingConflict).mockResolvedValue({
      identity: { kind: 'ok', botUserId: 'Ubot1', displayName: 'x', basicId: '@x' },
      conflicts: [{ workspaceId: 'wsA', name: 'Myfeel Test' }],
    })
    await expect(call()).rejects.toMatchObject({ statusCode: 409 })
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('沒撞號就照存，並把頻道身分記下來（下次比對免再打 LINE）', async () => {
    vi.mocked(checkChannelBindingConflict).mockResolvedValue({
      identity: { kind: 'ok', botUserId: 'Ubot9', displayName: 'x', basicId: '@x' },
      conflicts: [],
    })
    await expect(call()).resolves.toMatchObject({ ok: true })
    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(rememberChannelBinding).toHaveBeenCalledWith(expect.anything(), 'wsB', 'Ubot9')
  })

  it('🔴 問不到頻道身分時照樣存得進去（我方查不出來不該擋住客戶上線）', async () => {
    vi.mocked(checkChannelBindingConflict).mockResolvedValue({ identity: { kind: 'unknown' }, conflicts: [] })
    await expect(call()).resolves.toMatchObject({ ok: true })
    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(rememberChannelBinding).not.toHaveBeenCalled()
  })

  it('🔴 把憑證清空時，頻道身分要跟著清掉（否則會留一個對不到憑證的舊身分去擋別人）', async () => {
    body = { channelAccessToken: '' }
    await call()
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ channelAccessToken: '__delete__', lineBotUserId: '__delete__' }),
      { merge: true },
    )
    expect(checkChannelBindingConflict).not.toHaveBeenCalled()
  })

  it('只改名字不碰憑證時，不去問 LINE 也不動頻道身分', async () => {
    body = { name: '新名字' }
    await call()
    expect(checkChannelBindingConflict).not.toHaveBeenCalled()
    expect(setSpy).toHaveBeenCalledWith(expect.not.objectContaining({ lineBotUserId: expect.anything() }), { merge: true })
  })
})

/**
 * 「清除憑證」（`G-97`，2026-09-29 權限盤點）。
 * 🔴 原本是刪掉整份帳號文件：方案掉回免費、組織管理員進不去、組織停用擋不到、發票抬頭消失。
 *    按鈕文案寫的卻是「清掉本頁存的 Token／Secret」。
 */
describe('PUT /api/admin/line-workspace（clearWorkspace）', () => {
  const FULL_DOC = {
    name: '我的官方帳號',
    channelAccessToken: 'tok',
    channelSecret: 'sec',
    lineBotUserId: 'Ubot1',
    organizationId: 'org-1',
    subscription: { planId: 'pro' },
    invoiceProfile: { taxId: '12345678' },
  }

  it('🔴 只清 Token／Secret／頻道身分三格，⛔ 不刪整份文件（方案、組織、發票抬頭都要留著）', async () => {
    stubDb(FULL_DOC)
    body = { clearWorkspace: true }
    await expect(call()).resolves.toMatchObject({ ok: true, cleared: true })

    expect(deleteSpy).not.toHaveBeenCalled()
    expect(setSpy).toHaveBeenCalledTimes(1)
    const [patch, opts] = setSpy.mock.calls[0]! as [Record<string, unknown>, unknown]
    expect(opts).toEqual({ merge: true })
    expect(patch).toMatchObject({ channelAccessToken: '__delete__', channelSecret: '__delete__', lineBotUserId: '__delete__' })
    // 只動這三格（外加 updatedAt），別的欄位一個都不碰
    expect(Object.keys(patch).sort()).toEqual(['channelAccessToken', 'channelSecret', 'lineBotUserId', 'updatedAt'])
  })

  it('照樣寫稽核，而且只記「哪幾格被清」，不記值', async () => {
    stubDb(FULL_DOC)
    body = { clearWorkspace: true }
    await call()
    const audit = vi.mocked(writeAuditLog).mock.calls[0]![0]
    expect(audit).toMatchObject({ action: 'line-workspace.clear' })
    expect(JSON.stringify(audit)).not.toContain('tok"')
    expect(JSON.stringify(audit)).not.toContain('sec"')
  })

  it('本來就沒有存憑證 → 什麼都不寫（⛔ 不憑空生出一份只有 updatedAt 的文件），也不留空紀錄', async () => {
    stubDb({ name: '只有名字', organizationId: 'org-1' })
    body = { clearWorkspace: true }
    await expect(call()).resolves.toMatchObject({ ok: true })
    expect(setSpy).not.toHaveBeenCalled()
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(writeAuditLog).not.toHaveBeenCalled()

    stubDb(null)
    await call()
    expect(setSpy).not.toHaveBeenCalled()
  })
})
