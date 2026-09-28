import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 成員列表與邀請（2026-09-29 權限盤點）：
 * - GET 回 `isSelf`，成員頁照這格把自己那一列的角色選單與移除鈕藏起來（`G-101`②）
 * - POST 已經有帳號就直接加——**只認信箱驗證過的帳號**（`G-99`）：沒驗證過的可能是別人先拿這個信箱註冊的
 */

const { store } = vi.hoisted(() => ({
  store: {
    members: [] as { id: string, data: Record<string, unknown> }[],
    memberSets: [] as string[],
    inviteAdds: [] as Record<string, unknown>[],
    invites: [] as { id: string, data: Record<string, unknown> }[],
    invitesDeleted: 0,
    userRecord: null as null | { uid: string, emailVerified: boolean },
    superAdmin: true,
    seats: null as number | null,
  },
}))

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: 'w1', uid: 'me', isSuperAdmin: store.superAdmin })),
  invalidateWorkspaceMemberCache: vi.fn(),
}))
vi.mock('~~/server/utils/firebase', () => ({
  getFirebaseAuth: () => ({
    getUsers: async () => ({ users: [] }),
    getUserByEmail: async () => {
      if (!store.userRecord) throw new Error('no user')
      return store.userRecord
    },
  }),
  getDb: () => fakeDb(),
}))
vi.mock('~~/server/utils/billing', () => ({
  getWorkspacePlan: vi.fn(async () => (store.seats == null ? null : { seats: store.seats, name: '基本' })),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

function fakeDb() {
  const q = (docs: () => { id: string, data: Record<string, unknown> }[]): any => ({
    where: (f: string, _op: string, v: unknown) => q(() => docs().filter(d => d.data[f] === v)),
    limit: () => q(docs),
    count: () => ({ get: async () => ({ data: () => ({ count: docs().length }) }) }),
    get: async () => {
      const list = docs().map(d => ({ id: d.id, ref: { id: d.id }, data: () => d.data }))
      return { docs: list, empty: list.length === 0 }
    },
  })
  return {
    batch: () => ({
      delete: (ref: { id: string }) => {
        store.invites = store.invites.filter(i => i.id !== ref.id)
        store.invitesDeleted++
      },
      commit: async () => {},
    }),
    collection: (col: string) => ({
      ...q(() => (col === 'workspaceMembers' ? store.members : col === 'workspaceInvites' ? store.invites : [])),
      doc: (id: string) => ({
        get: async () => ({ exists: col === 'workspaces', data: () => ({}) }),
        set: async () => { store.memberSets.push(id) },
      }),
      add: async (d: Record<string, unknown>) => {
        store.inviteAdds.push(d)
        return { id: 'inv1' }
      },
    }),
  }
}
vi.stubGlobal('getDb', () => fakeDb())

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: getHandler } = await import('./index.get')
const { default: postHandler } = await import('./index.post')

beforeEach(() => {
  store.members = [
    { id: 'me_w1', data: { uid: 'me', workspaceId: 'w1', role: 'admin', invitedEmail: 'me@x.tw' } },
    { id: 'ag_w1', data: { uid: 'ag', workspaceId: 'w1', role: 'agent', invitedEmail: 'ag@x.tw' } },
  ]
  store.memberSets = []
  store.inviteAdds = []
  store.invites = []
  store.invitesDeleted = 0
  store.userRecord = null
  store.superAdmin = true
  store.seats = null
})

const DAY = 24 * 60 * 60 * 1000

describe('GET members', () => {
  it('⭐ 自己那一列 isSelf=true，別人 false', async () => {
    const rows = await (getHandler as any)({}) as { id: string, isSelf?: boolean }[]
    expect(rows.find(r => r.id === 'me_w1')?.isSelf).toBe(true)
    expect(rows.find(r => r.id === 'ag_w1')?.isSelf).toBe(false)
  })

  it('門檻是 members.read（`D-111`：收到管理員）', async () => {
    const { requireCapability } = await import('~~/server/utils/workspace-auth')
    await (getHandler as any)({})
    expect(requireCapability).toHaveBeenCalledWith(expect.anything(), 'members.read')
  })

  it('🔴 邀請帶 expired（`G-107`⑥）：過期的照樣列出來，⛔ 不藏', async () => {
    store.invites = [
      { id: 'i-old', data: { workspaceId: 'w1', email: 'old@x.tw', role: 'agent', expiresAt: Date.now() - DAY } },
      { id: 'i-new', data: { workspaceId: 'w1', email: 'new@x.tw', role: 'agent', expiresAt: Date.now() + DAY } },
    ]
    const rows = await (getHandler as any)({}) as { id: string, expired?: boolean }[]
    expect(rows.find(r => r.id === 'i-old')?.expired).toBe(true)
    expect(rows.find(r => r.id === 'i-new')?.expired).toBe(false)
  })
})

describe('POST members（邀請）', () => {
  it('🔴 對方已有帳號但信箱沒驗證 → ⛔ 不直接加，改發邀請', async () => {
    store.userRecord = { uid: 'squatter', emailVerified: false }
    body = { email: 'New@X.tw', role: 'agent' }
    const r = await (postHandler as any)({})
    expect(r).toMatchObject({ pending: true, uid: null })
    expect(store.memberSets).toHaveLength(0)
    expect(store.inviteAdds[0]).toMatchObject({ email: 'new@x.tw', role: 'agent' })
  })

  it('新邀請存 expiresAt＝30 天後（`G-107`⑥）', async () => {
    body = { email: 'new@x.tw', role: 'agent' }
    const before = Date.now()
    await (postHandler as any)({})
    const exp = Number(store.inviteAdds[0]?.expiresAt)
    expect(exp).toBeGreaterThanOrEqual(before + 30 * DAY)
    expect(exp).toBeLessThanOrEqual(Date.now() + 30 * DAY)
  })

  it('還有效的邀請 → 409；只剩過期的 → 收掉舊的、發一張新的（＝重新邀請）', async () => {
    store.invites = [{ id: 'i1', data: { workspaceId: 'w1', email: 'new@x.tw', role: 'agent', expiresAt: Date.now() + DAY } }]
    body = { email: 'new@x.tw', role: 'agent' }
    await expect((postHandler as any)({})).rejects.toMatchObject({ statusCode: 409 })

    store.invites = [{ id: 'i1', data: { workspaceId: 'w1', email: 'new@x.tw', role: 'agent', expiresAt: Date.now() - DAY } }]
    const r = await (postHandler as any)({})
    expect(r).toMatchObject({ pending: true })
    expect(store.invitesDeleted).toBe(1)
    expect(store.inviteAdds).toHaveLength(1)
  })

  it('🔴 過期的邀請不佔席次', async () => {
    store.superAdmin = false
    store.seats = 3 // 已有 2 位成員＋1 張過期邀請：過期的不算，還邀得進第 3 位
    store.invites = [{ id: 'i-old', data: { workspaceId: 'w1', email: 'old@x.tw', role: 'agent', expiresAt: Date.now() - DAY } }]
    body = { email: 'third@x.tw', role: 'agent' }
    await expect((postHandler as any)({})).resolves.toMatchObject({ pending: true })

    store.invites.push({ id: 'i-live', data: { workspaceId: 'w1', email: 'live@x.tw', role: 'agent', expiresAt: Date.now() + DAY } })
    body = { email: 'fourth@x.tw', role: 'agent' }
    await expect((postHandler as any)({})).rejects.toMatchObject({ statusCode: 403 })
  })

  it('信箱驗證過 → 照舊直接加成成員', async () => {
    store.userRecord = { uid: 'real', emailVerified: true }
    body = { email: 'new@x.tw', role: 'agent' }
    const r = await (postHandler as any)({})
    expect(r).toMatchObject({ pending: false, uid: 'real' })
    expect(store.memberSets).toEqual(['real_w1'])
  })
})
