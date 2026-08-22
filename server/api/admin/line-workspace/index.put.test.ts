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
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: 'wsB' })),
}))
vi.mock('~~/server/utils/line-workspace-credentials', () => ({
  invalidateLineWorkspaceCredentialsCache: vi.fn(),
}))
vi.mock('~~/server/utils/line-webhook-remote', () => ({
  fetchLineWebhookEndpoint: vi.fn(),
  postLineWebhookTest: vi.fn(),
}))
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

const setSpy = vi.fn(async () => {})
function stubDb() {
  vi.mocked(getDb).mockReturnValue({
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: true, data: () => ({ name: '舊名字' }) }),
        set: setSpy,
      }),
    }),
  } as never)
}

const call = () => (handler as unknown as (e: unknown) => Promise<unknown>)({})

beforeEach(() => {
  vi.clearAllMocks()
  setSpy.mockClear()
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
