import { describe, expect, it, vi } from 'vitest'

/**
 * 撤銷超管要當下生效（`G-104`②，2026-09-29 權限盤點）：原本只改 claims，
 * 他手上那張 ID token 到期前（最長 1 小時）還帶著 superAdmin。
 * 這裡守「有撤 refresh token」；守門那邊的 checkRevoked 在 workspace-auth.test.ts。
 */

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('~~/server/utils/workspace-auth', () => ({ requireSuperAdmin: vi.fn(async () => ({ uid: 'boss' })) }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/firebase', () => ({
  getFirebaseAuth: () => ({
    getUser: async () => ({ email: 'ex@x.tw', customClaims: { superAdmin: true, other: 1 } }),
    setCustomUserClaims: async (_uid: string, claims: Record<string, unknown>) => { calls.push(`claims:${JSON.stringify(claims)}`) },
    revokeRefreshTokens: async (uid: string) => { calls.push(`revoke:${uid}`) },
  }),
}))

vi.stubGlobal('getDb', () => ({
  collection: () => ({
    get: async () => ({ size: 2 }),
    doc: () => ({ delete: async () => { calls.push('index-delete') } }),
  }),
}))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'ex')
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./super-admin.delete')

describe('DELETE /api/admin/super/users/:uid/super-admin', () => {
  it('🔴 拿掉 claim 之後撤掉他的 refresh token（不然手上的 token 還能用一小時）', async () => {
    await (handler as any)({})
    expect(calls).toContain('claims:{"other":1}')
    expect(calls).toContain('revoke:ex')
    // 先改 claims 再撤：他重新登入拿到的新 token 才不會又帶著 superAdmin
    expect(calls.indexOf('claims:{"other":1}')).toBeLessThan(calls.indexOf('revoke:ex'))
  })
})
