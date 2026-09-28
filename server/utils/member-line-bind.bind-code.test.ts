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
})
