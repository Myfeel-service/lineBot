import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 活動頁失敗回報端點。這支沒有辦法驗身分（失敗的當下客人連 LIFF token 都拿不到），
 * 所以釘的是三件「不可以做的事」：不認得的代碼不寫、認不出租戶不寫、
 * 呼叫端自報的 workspaceId 不採信。
 */

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn(() => ({})) }))
vi.mock('~~/server/utils/liff-tenant-resolve', () => ({
  resolveWorkspaceIdByLiffChannelId: vi.fn(),
}))
vi.mock('~~/server/utils/lead-page-failures', () => ({ recordLeadPageFailure: vi.fn(async () => {}) }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('setResponseStatus', vi.fn())

let body: unknown = {}
vi.stubGlobal('readBody', async () => body)

const { default: handler } = await import('./lead-error.post')
const { resolveWorkspaceIdByLiffChannelId } = await import('~~/server/utils/liff-tenant-resolve')
const { recordLeadPageFailure } = await import('~~/server/utils/lead-page-failures')

beforeEach(() => {
  vi.mocked(recordLeadPageFailure).mockClear()
  vi.mocked(resolveWorkspaceIdByLiffChannelId).mockReset()
  vi.mocked(resolveWorkspaceIdByLiffChannelId).mockResolvedValue({ workspaceId: 'ws1', defaultLiffId: '' })
})

const call = () => (handler as (e: unknown) => Promise<{ ok: boolean, recorded: boolean }>)({})

describe('POST /api/liff/lead-error', () => {
  it('認得的代碼 → 記下來，租戶用 liffId 反查出來的那個', async () => {
    body = { reason: 'liff_init_failed', liffId: '2007123456-AbCdEfGh', campaignCode: 'c' }
    await expect(call()).resolves.toEqual({ ok: true, recorded: true })
    expect(vi.mocked(resolveWorkspaceIdByLiffChannelId).mock.calls[0]?.[0]).toBe('2007123456')
    expect(recordLeadPageFailure).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId: 'ws1',
      reason: 'liff_init_failed',
    }))
  })

  it('不認得的代碼 → 一個字都不寫', async () => {
    body = { reason: 'something_new', liffId: '2007123456-AbCdEfGh' }
    await expect(call()).resolves.toEqual({ ok: false, recorded: false })
    expect(recordLeadPageFailure).not.toHaveBeenCalled()
  })

  it('認不出租戶 → 不寫（⛔ 記到 default 會讓 A 家的災情算在 B 家頭上）', async () => {
    vi.mocked(resolveWorkspaceIdByLiffChannelId).mockResolvedValue({ workspaceId: '', defaultLiffId: '' })
    body = { reason: 'load_timeout', liffId: '2007123456-AbCdEfGh' }
    await expect(call()).resolves.toEqual({ ok: true, recorded: false })
    expect(recordLeadPageFailure).not.toHaveBeenCalled()
  })

  it('⛔ body 自報的 workspaceId 不採信', async () => {
    body = { reason: 'claim_failed', workspaceId: '別人家', liffId: '2007123456-AbCdEfGh' }
    await call()
    expect(recordLeadPageFailure).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId: 'ws1',
    }))
  })

  it('寫入失敗不對外拋錯（客人不該因為回報失敗再看到一個錯誤）', async () => {
    vi.mocked(recordLeadPageFailure).mockRejectedValueOnce(new Error('firestore down'))
    body = { reason: 'claim_failed', liffId: '2007123456-AbCdEfGh' }
    await expect(call()).resolves.toEqual({ ok: true, recorded: false })
  })
})
