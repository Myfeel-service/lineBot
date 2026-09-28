import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 移除組織管理員（`G-96` 2026-09-29 拍板）：一併移出組織底下每個官方帳號。
 * 守順序：護欄先過 → 移出各帳號 → 才刪組織那一筆；各帳號沒移乾淨就 ⛔ 不刪組織那一筆（刪了就沒有重試入口）。
 */

type Row = { id: string, data: Record<string, unknown> }

const { store, cascade } = vi.hoisted(() => ({
  store: { orgMembers: [] as Row[], events: [] as string[] },
  cascade: { failed: [] as string[] },
}))

vi.mock('~~/server/utils/workspace-auth', () => ({
  requireActiveOrgAdmin: vi.fn(async () => ({ uid: 'boss', email: 'boss@x.tw' })),
  invalidateOrgMemberCache: vi.fn(),
}))
vi.mock('~~/server/utils/org-member-cascade', () => ({
  removeOrgMemberFromWorkspaces: vi.fn(async ({ email }: { email: string }) => {
    store.events.push(`cascade:${email}`)
    return { removed: [{ workspaceId: 'w1', uid: 'u1', role: 'owner' }], invitesDeleted: 0, failedWorkspaceIds: cascade.failed }
  }),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/firebase', () => {
  const membersQuery = { get: async () => ({ docs: store.orgMembers.map(r => ({ id: r.id, data: () => r.data })) }) }
  return {
    getDb: () => ({
      collection: (col: string) => col === 'organizations'
        ? { doc: () => ({ get: async () => ({ data: () => ({ ownerEmail: 'owner@x.tw' }) }) }) }
        : { doc: (id: string) => ({ id }), where: () => membersQuery },
      runTransaction: async (fn: (tx: unknown) => unknown) => fn({
        get: (q: { get: () => unknown }) => q.get(),
        delete: (ref: { id: string }) => {
          store.events.push(`delete:${ref.id}`)
          store.orgMembers = store.orgMembers.filter(r => r.id !== ref.id)
        },
      }),
    }),
  }
})

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./[docId].delete')
const del = (docId: string) => (handler as any)({ context: { params: { orgId: 'orgA', docId } } })

beforeEach(() => {
  store.orgMembers = [
    { id: 'm-boss', data: { orgId: 'orgA', email: 'boss@x.tw' } },
    { id: 'm-owner', data: { orgId: 'orgA', email: 'owner@x.tw' } },
    { id: 'm-ex', data: { orgId: 'orgA', email: 'ex@x.tw' } },
  ]
  store.events = []
  cascade.failed = []
})

describe('DELETE /api/admin/org/:orgId/members/:docId', () => {
  it('⭐ 先移出各帳號、再刪組織那一筆', async () => {
    const r = await del('m-ex')
    expect(store.events).toEqual(['cascade:ex@x.tw', 'delete:m-ex'])
    expect(r).toMatchObject({ ok: true, email: 'ex@x.tw', removedFromWorkspaces: 1 })
  })

  it('🔴 各帳號沒移乾淨 → 500，⛔ 組織那一筆不刪（刪了就從組織頁消失、沒有重試入口）', async () => {
    cascade.failed = ['w1']
    await expect(del('m-ex')).rejects.toMatchObject({ statusCode: 500 })
    expect(store.orgMembers.some(r => r.id === 'm-ex')).toBe(true)
  })

  it('🔴 三道護欄照舊，而且擋下來時 ⛔ 不先動各帳號', async () => {
    await expect(del('m-boss')).rejects.toMatchObject({ statusCode: 400, statusMessage: '不能移除自己。請由其他管理員操作' })
    await expect(del('m-owner')).rejects.toMatchObject({ statusCode: 400, statusMessage: '不能移除組織的登記擁有者' })
    store.orgMembers = [{ id: 'm-ex', data: { orgId: 'orgA', email: 'ex@x.tw' } }]
    await expect(del('m-ex')).rejects.toMatchObject({ statusCode: 400 })
    await expect(del('nope')).rejects.toMatchObject({ statusCode: 404 })
    expect(store.events).toEqual([])
  })
})
