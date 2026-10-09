import { describe, expect, it, vi } from 'vitest'

/**
 * 綁定碼的亂數（`G-107`⑬，2026-09-29 權限盤點）：這組碼在有效期內誰拿到就能把自己的 LINE 綁成這位成員，
 * ⛔ 不能用 `Math.random`（不是拿來產密碼的亂數）。
 */

const { writes } = vi.hoisted(() => ({ writes: [] as Record<string, unknown>[] }))

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({}), delete: () => '__del__' } }))
vi.mock('./firebase', () => ({
  getDb: () => ({
    collection: () => ({
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: true, data: () => ({}) }),
        update: async (p: Record<string, unknown>) => { writes.push(p) },
      }),
      where: () => ({ get: async () => ({ docs: [] }) }),
    }),
  }),
}))
vi.mock('./ai-settings', () => ({ AI_SETTINGS_COLLECTION: 'aiSettings', invalidateAiSettingsCache: vi.fn(), getAiSettings: vi.fn() }))
vi.mock('./line', () => ({ getUserProfile: vi.fn(), replyMessage: vi.fn() }))
vi.mock('./line-oa-basic-id', () => ({ resolveLineOaBasicId: vi.fn(async () => '@demo') }))
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { issueMemberLineBindCode } = await import('./member-line-bind')

describe('issueMemberLineBindCode 的碼', () => {
  it('🔴 不用 Math.random；6 碼、只用去掉易混淆字的字母表', async () => {
    const spy = vi.spyOn(Math, 'random')
    const { code } = await issueMemberLineBindCode('w', 'u1')
    expect(spy).not.toHaveBeenCalled()
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/)
    expect(writes.at(-1)).toMatchObject({ lineBindCode: code })
    spy.mockRestore()
  })

  /**
   * `D-119` 拍板 A（2026-10-09）：管理員「傳連結給他」改 24 小時——同事常常幾小時後才點，
   * 10 分鐘的版本上線以來只用過一次、那位到今天都沒綁上。自己掃 QR 的人就在電腦前，維持 10 分鐘。
   * 記下是誰產的，過期回覆才知道叫他找誰。
   */
  it('自己掃的 10 分鐘、管理員傳的 24 小時，並記下是誰產的', async () => {
    const t0 = Date.now()
    const self = await issueMemberLineBindCode('w', 'u1', 'self')
    expect(self.expiresAt - t0).toBeGreaterThanOrEqual(10 * 60_000 - 1000)
    expect(self.expiresAt - t0).toBeLessThanOrEqual(10 * 60_000 + 1000)
    expect(writes.at(-1)).toMatchObject({ lineBindCodeBy: 'self' })

    const admin = await issueMemberLineBindCode('w', 'u1', 'admin')
    expect(admin.expiresAt - t0).toBeGreaterThanOrEqual(24 * 3600_000 - 1000)
    expect(writes.at(-1)).toMatchObject({ lineBindCodeBy: 'admin', lineBindCodeIssuedAt: expect.any(Number) })
  })
})
