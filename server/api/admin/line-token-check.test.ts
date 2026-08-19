import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「這把 Channel Access Token 是真的嗎」端點。
 *
 * 釘住的是**三態誠實**——這支的答案會直接決定要不要擋住使用者：
 *   ① LINE 明說不認得（401／403）才回 false → 開通引導會退回去叫人重貼
 *   ② LINE 自己出事（5xx）、太頻繁（429）、我們連不出去 → 一律回 null（「這次問不到」），
 *      **不可以**回 false。回錯的話，鑰匙明明是好的卻被擋在門外，人只會一直重貼同一把
 *   ③ 驗過要回帳號名稱：「貼成另一個官方帳號的鑰匙」只有靠這個看得出來
 */

vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: 'ws1' })),
}))
vi.mock('~~/server/utils/line-webhook-remote', () => ({ fetchLineBotInfo: vi.fn() }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

let body: Record<string, unknown> = {}
vi.stubGlobal('readBody', async () => body)

const { default: handler } = await import('./line-token-check.post')
const { fetchLineBotInfo } = await import('~~/server/utils/line-webhook-remote')

const call = () => (handler as unknown as (e: unknown) => Promise<{ valid: boolean | null, displayName?: string }>)({})

beforeEach(() => {
  vi.clearAllMocks()
  body = { channelAccessToken: 'a'.repeat(40) }
})

describe('POST /api/admin/line-token-check', () => {
  it('LINE 認得：回 valid 與帳號名稱（讓人自己確認是不是要接的那個帳號）', async () => {
    vi.mocked(fetchLineBotInfo).mockResolvedValue({
      ok: true,
      data: { displayName: '喵喵工作室', basicId: '@meow', userId: 'U1' },
    })
    await expect(call()).resolves.toEqual({ valid: true, displayName: '喵喵工作室', basicId: '@meow' })
  })

  it('🔴 401／403 才敢說「不認得」', async () => {
    for (const status of [401, 403]) {
      vi.mocked(fetchLineBotInfo).mockResolvedValue({ ok: false, status, body: {} })
      await expect(call()).resolves.toEqual({ valid: false })
    }
  })

  it('🔴 LINE 自己出事或太頻繁：回「這次問不到」，不可以說鑰匙是壞的', async () => {
    for (const status of [429, 500, 502, 503]) {
      vi.mocked(fetchLineBotInfo).mockResolvedValue({ ok: false, status, body: {} })
      await expect(call()).resolves.toEqual({ valid: null })
    }
  })

  it('🔴 我們自己連不出去（丟例外）也是「問不到」，不是「鑰匙壞掉」', async () => {
    vi.mocked(fetchLineBotInfo).mockRejectedValue(new Error('ENOTFOUND'))
    await expect(call()).resolves.toEqual({ valid: null })
  })

  it('沒帶鑰匙就回 400，不去打 LINE', async () => {
    body = {}
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchLineBotInfo).not.toHaveBeenCalled()
  })
})
