import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 活動頁公開設定（不用登入，`G-105`）：`?workspaceId=` 帶明顯亂編的值時，
 * ⛔ 不可以讀庫、也不可以塞進快取——那是任何人都能免費觸發的讀取費與記憶體成長。
 * 真的帳號 id 照舊查得到。
 */

vi.mock('~~/server/utils/line-workspace-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~~/server/utils/line-workspace-credentials')>()),
  getLineWorkspaceCredentials: vi.fn(async () => ({ defaultLiffId: '2007123456-AbCdEfGh' })),
}))
vi.mock('~~/server/utils/line-oa-basic-id', () => ({ resolveLineOaBasicId: vi.fn(async () => '@oa') }))
vi.mock('~~/server/utils/liff-tenant-resolve', () => ({ resolveWorkspaceIdByLiffChannelId: vi.fn() }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('setResponseHeader', vi.fn())
let query: Record<string, string> = {}
vi.stubGlobal('getQuery', () => query)

const { default: handler } = await import('./config.get')
const { getLineWorkspaceCredentials } = await import('~~/server/utils/line-workspace-credentials')

beforeEach(() => vi.mocked(getLineWorkspaceCredentials).mockClear())

const call = () => (handler as (e: unknown) => Promise<{ liffId: string, lineOaBasicId: string }>)({})

describe('GET /api/liff/config', () => {
  it('真的帳號 id 照舊查得到', async () => {
    query = { workspaceId: '3f2b9c1e-8a4d-4f6b-9e21-7c5d0a1b2c3d' }
    await expect(call()).resolves.toEqual({ liffId: '2007123456-AbCdEfGh', lineOaBasicId: '@oa' })
  })

  it('⛔ 明顯亂編的值：回空、一次庫都不讀', async () => {
    for (const bad of ['a/b/c', 'x'.repeat(200), '<script>alert(1)</script>']) {
      query = { workspaceId: bad }
      await expect(call()).resolves.toEqual({ liffId: '', lineOaBasicId: '' })
    }
    expect(getLineWorkspaceCredentials).not.toHaveBeenCalled()
  })
})
