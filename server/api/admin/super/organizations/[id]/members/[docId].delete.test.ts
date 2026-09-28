import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 超管移除組織管理員（`G-96` 2026-09-29 拍板）：跟組織自己那支一樣，一併移出組織底下每個官方帳號；
 * 各帳號沒移乾淨就 ⛔ 不刪組織那一筆。
 */

const { store, cascade } = vi.hoisted(() => ({
  store: { exists: true, events: [] as string[] },
  cascade: { failed: [] as string[] },
}))

vi.mock('~~/server/utils/workspace-auth', () => ({
  requireSuperAdmin: vi.fn(async () => ({ uid: 'super1' })),
  invalidateOrgMemberCache: vi.fn(),
}))
vi.mock('~~/server/utils/org-member-cascade', () => ({
  removeOrgMemberFromWorkspaces: vi.fn(async ({ email }: { email: string }) => {
    store.events.push(`cascade:${email}`)
    return { removed: [], invitesDeleted: 0, failedWorkspaceIds: cascade.failed }
  }),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

vi.stubGlobal('getDb', () => ({
  collection: () => ({
    doc: () => ({
      get: async () => ({ exists: store.exists, data: () => ({ orgId: 'orgA', email: 'ex@x.tw' }) }),
      delete: async () => { store.events.push('delete') },
    }),
  }),
}))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', (_e: unknown, k: string) => (k === 'id' ? 'orgA' : 'm-ex'))
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./[docId].delete')

beforeEach(() => {
  store.exists = true
  store.events = []
  cascade.failed = []
})

describe('DELETE /api/admin/super/organizations/:id/members/:docId', () => {
  it('⭐ 先移出各帳號、再刪組織那一筆', async () => {
    await (handler as any)({})
    expect(store.events).toEqual(['cascade:ex@x.tw', 'delete'])
  })

  it('🔴 各帳號沒移乾淨 → 500，⛔ 組織那一筆不刪', async () => {
    cascade.failed = ['w1']
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 500 })
    expect(store.events).toEqual(['cascade:ex@x.tw'])
  })
})
