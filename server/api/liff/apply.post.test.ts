import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 活動頁收尾（`G-94`）：只有**真的在這個帳號登記過活動**的人，才會被加進那家的好友名單。
 * 以前只驗「是真的 LINE 使用者」、帳號 id 用 body 帶的（而 claim 會把帳號 id 回給任何參加者），
 * 任何 LINE 帳號都能把自己塞進任一家的好友名單。
 */

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/handler', () => ({ handleFollowEvent: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/liff-token', () => ({
  verifyLiffAccessToken: vi.fn(async () => ({ userId: 'U1', displayName: '小明', pictureUrl: 'p', clientId: '2007123456' })),
  warnOnLiffChannelMismatch: vi.fn(),
}))
vi.mock('~~/server/utils/line-workspace-credentials', () => ({
  getLineWorkspaceCredentials: vi.fn(async () => ({ defaultLiffId: '2007123456-AbCdEfGh' })),
}))

const setResponseStatus = vi.fn()
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('setResponseStatus', setResponseStatus)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))
let body: Record<string, unknown> = {}
vi.stubGlobal('readBody', async () => body)

const { default: handler } = await import('./apply.post')
const { getDb } = await import('~~/server/utils/firebase')
const { handleFollowEvent } = await import('~~/server/utils/handler')
const { warnOnLiffChannelMismatch } = await import('~~/server/utils/liff-token')

/** leadClaims：照查詢條件（lineUserId＋status）過濾，跟正式庫的語意一樣 */
function stubClaims(rows: Array<{ lineUserId: string, workspaceId: string, status: string }>) {
  const filters: Record<string, unknown> = {}
  const q: any = {
    where: (field: string, _op: string, value: unknown) => { filters[field] = value; return q },
    get: async () => ({
      docs: rows
        .filter(r => Object.entries(filters).every(([k, v]) => (r as Record<string, unknown>)[k] === v))
        .map(r => ({ data: () => r })),
    }),
  }
  vi.mocked(getDb).mockReturnValue({ collection: () => q } as never)
}

const call = () => (handler as (e: unknown) => Promise<{ ok: boolean }>)({})

beforeEach(() => {
  vi.mocked(handleFollowEvent).mockClear()
  vi.mocked(warnOnLiffChannelMismatch).mockClear()
  setResponseStatus.mockClear()
  body = { accessToken: 'at', workspaceId: 'wsA' }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('POST /api/liff/apply', () => {
  it('這個人在這個帳號有 claimed 的活動登記 → 照常套用', async () => {
    stubClaims([{ lineUserId: 'U1', workspaceId: 'wsA', status: 'claimed' }])
    await expect(call()).resolves.toEqual({ ok: true })
    expect(handleFollowEvent).toHaveBeenCalledWith('U1', { displayName: '小明', pictureUrl: 'p' }, 'wsA')
    await vi.waitFor(() => expect(warnOnLiffChannelMismatch).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U1' }), '2007123456-AbCdEfGh', 'liff/apply'))
  })

  it('🔴 沒登記過就指定別家帳號 → 403，⛔ 不可以把他加成那家的好友', async () => {
    stubClaims([])
    await expect(call()).resolves.toEqual({ ok: false })
    expect(setResponseStatus).toHaveBeenCalledWith(expect.anything(), 403)
    expect(handleFollowEvent).not.toHaveBeenCalled()
  })

  it('🔴 在 A 家登記過，拿去指定 B 家 → 403', async () => {
    stubClaims([{ lineUserId: 'U1', workspaceId: 'wsA', status: 'claimed' }])
    body = { accessToken: 'at', workspaceId: 'wsB' }
    await expect(call()).resolves.toEqual({ ok: false })
    expect(handleFollowEvent).not.toHaveBeenCalled()
  })

  it('別人在這家登記過不算數（userId 以 LINE 驗出來的為準）', async () => {
    stubClaims([{ lineUserId: 'U-someone-else', workspaceId: 'wsA', status: 'claimed' }])
    await expect(call()).resolves.toEqual({ ok: false })
    expect(handleFollowEvent).not.toHaveBeenCalled()
  })

  it('那筆已經被 follow webhook 套用掉（applied）→ 不再做一次', async () => {
    stubClaims([{ lineUserId: 'U1', workspaceId: 'wsA', status: 'applied' }])
    await expect(call()).resolves.toEqual({ ok: false })
    expect(handleFollowEvent).not.toHaveBeenCalled()
  })
})
