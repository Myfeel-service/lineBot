import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 落地頁留名單（公開端點）的 per-IP 節流（`G-105`）。
 *
 * 釘的是：節流 key 取 `X-Forwarded-For` **倒數第二格**（CloudFront 看到的訪客）。原本用 h3 的
 * `getRequestIP(event, { xForwardedFor: true })`，它取最左邊——那格客人自己填，
 * 每送一次換一個值，「每個 IP 10 分鐘 8 次」就等於沒有。
 * 最右邊那格是 Amplify 接上的 CloudFront 節點位址（2026-10-19 線上實測 `G-110`），取它＝同一個節點後面的人共用 8 次。
 * 下面的標頭照正式站的形狀：[客人自己帶的…, 訪客, CloudFront 節點]。
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
      await expect(post(`6.6.6.${i}, 203.0.113.9, 130.176.1.1`, i)).resolves.toEqual({ ok: true })
    await expect(post('6.6.6.99, 203.0.113.9, 130.176.1.1', 99)).rejects.toMatchObject({ statusCode: 429 })
    expect(writes).toHaveLength(8)
  })

  it('別的來源不受影響', async () => {
    await expect(post('203.0.113.10, 130.176.1.1', 1)).resolves.toEqual({ ok: true })
  })

  it('⛔ 同一個 CloudFront 節點後面的不同訪客各算各的（以前第 9 個人起就被擋）', async () => {
    for (let i = 0; i < 12; i++)
      await expect(post(`198.51.100.${i}, 130.176.2.2`, 200 + i)).resolves.toEqual({ ok: true })
  })
})
