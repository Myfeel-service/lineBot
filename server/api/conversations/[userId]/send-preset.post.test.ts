import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 送出客服預存的帳號邊界（`G-98`，2026-09-29 權限盤點）。
 *
 * 🔴 隔壁 `quick-reply-text.get` 有比對預存是不是這個帳號的，這支漏了：知道別家預存的 id，
 * 就能把別家的文字推到自家客人手上、存進自家對話紀錄，預存上設定的貼標也照單全貼。
 */

const WS = 'ws1'

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, token: { name: '客服小美' } })),
}))
vi.mock('~~/server/utils/handler', () => ({ pushSupportPresetActionToUser: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/line-send-error', () => ({ describeLineSendFailure: () => null }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => `${WS}_U1`)
vi.stubGlobal('getHeader', () => '')
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./send-preset.post')
const { getDb } = await import('~~/server/utils/firebase')
const { pushSupportPresetActionToUser } = await import('~~/server/utils/handler')

const DOCS: Record<string, Record<string, Record<string, unknown>>> = {
  users: { [`${WS}_U1`]: { workspaceId: WS } },
  supportPresets: {
    mine: { workspaceId: WS, name: '我家的', isActive: true, action: { type: 'message', text: '您好' } },
    theirs: { workspaceId: 'ws2', name: '別家的', isActive: true, action: { type: 'message', text: '別家的話術' } },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getDb).mockReturnValue({
    collection: (col: string) => ({
      doc: (id: string) => ({ get: async () => ({ id, exists: !!DOCS[col]?.[id], data: () => DOCS[col]?.[id] }) }),
    }),
  } as never)
})

const call = () => (handler as unknown as (e: unknown) => Promise<unknown>)({})

describe('POST /api/conversations/:userId/send-preset', () => {
  it('自己的預存照常送出', async () => {
    body = { presetId: 'mine' }
    await expect(call()).resolves.toEqual({ ok: true })
    expect(pushSupportPresetActionToUser).toHaveBeenCalledTimes(1)
  })

  it('🔴 別家的預存 → 404（當作不存在），一個字都不推給客人', async () => {
    body = { presetId: 'theirs' }
    await expect(call()).rejects.toMatchObject({ statusCode: 404 })
    expect(pushSupportPresetActionToUser).not.toHaveBeenCalled()
  })
})
