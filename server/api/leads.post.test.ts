import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 落地頁留名單（公開端點）的 per-IP 節流（`G-105`）。
 *
 * 釘的是：節流 key 取 `X-Forwarded-For` **最右邊**那格。原本用 h3 的
 * `getRequestIP(event, { xForwardedFor: true })`，它取最左邊——那格客人自己填，
 * 每送一次換一個值，「每個 IP 10 分鐘 8 次」就等於沒有。
 */

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))
vi.stubGlobal('getHeader', (e: { node: { req: { headers: Record<string, string> } } }, name: string) =>
  e.node.req.headers[name.toLowerCase()])
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)

const { default: handler } = await import('./leads.post')
const { getDb } = await import('~~/server/utils/firebase')

const writes: unknown[] = []
beforeEach(() => {
  writes.length = 0
  vi.mocked(getDb).mockReturnValue({
    collection: () => ({
      where: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
      doc: () => ({ set: async (d: unknown) => { writes.push(d) } }),
    }),
  } as never)
})

const post = (xff: string, i: number) => (handler as (e: unknown) => Promise<unknown>)({
  body: { contact: `lead${i}@example.com` },
  node: { req: { headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.1' } } },
})

describe('POST /api/leads 節流', () => {
  it('⛔ 最左邊每次換一個值也繞不過：同一個真實來源第 9 次就擋', async () => {
    for (let i = 0; i < 8; i++)
      await expect(post(`6.6.6.${i}, 203.0.113.9`, i)).resolves.toEqual({ ok: true })
    await expect(post('6.6.6.99, 203.0.113.9', 99)).rejects.toMatchObject({ statusCode: 429 })
    expect(writes).toHaveLength(8)
  })

  it('別的來源不受影響', async () => {
    await expect(post('203.0.113.10', 1)).resolves.toEqual({ ok: true })
  })
})
