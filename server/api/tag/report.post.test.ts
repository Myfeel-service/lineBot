import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 好友統計「重新產生」的冷卻（`D-28` 鐵律①）＋改版前舊報告不擋冷卻（`C-404`）。
 *
 * 舊報告（`D-155` 以前的形狀）畫不出任何東西，畫面叫他按「重新產生」——
 * 那一小時內按鈕卻是灰的、按了回 429，就是自相矛盾。
 */

let prev: { generatedAtMs: number, legacy: boolean } | null = null
const generateTagReport = vi.fn(async () => ({ generatedAtMs: Date.now(), generatedBy: 'x', payload: { version: 2 }, legacy: false }))

vi.mock('~~/server/utils/firebase', () => ({ getDb: () => ({}) }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: 'ws1', token: { name: '守門員' } })),
}))
vi.mock('~~/server/utils/tag-report', () => ({
  getTagReport: vi.fn(async () => prev),
  generateTagReport,
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: post } = await import('./report.post')
const { default: get } = await import('./report.get')

beforeEach(() => {
  generateTagReport.mockClear()
  prev = null
})

describe('重新產生的冷卻', () => {
  it('⛔ 新版報告一小時內不能再算（成本閘門照舊）', async () => {
    prev = { generatedAtMs: Date.now() - 20 * 60_000, legacy: false }
    await expect((post as any)({})).rejects.toMatchObject({ statusCode: 429 })
    expect(generateTagReport).not.toHaveBeenCalled()
    expect(await (get as any)({})).toMatchObject({ canRegenerate: false })
  })

  it('改版前的舊報告不擋冷卻：GET 說可以、POST 真的算（C-404）', async () => {
    prev = { generatedAtMs: Date.now() - 20 * 60_000, legacy: true }
    expect(await (get as any)({})).toMatchObject({ canRegenerate: true, cooldownRemainingMs: 0 })
    await (post as any)({})
    expect(generateTagReport).toHaveBeenCalledTimes(1)
  })
})
