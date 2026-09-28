import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 移出組織＝移出組織底下每一個官方帳號（`G-96` 2026-09-29 拍板）。
 * 原本只刪組織名單那一筆，他在各帳號的成員身分原封不動（自己開的帳號裡還是誰都拿不掉的擁有者）。
 */

type Row = { id: string, data: Record<string, unknown> }

const { store } = vi.hoisted(() => ({
  store: {
    workspaces: [] as Row[],
    members: [] as Row[],
    invites: [] as Row[],
    authUid: 'u1' as string | null,
    notifyFail: new Set<string>(),
    events: [] as string[],
  },
}))

vi.mock('./firebase', () => ({
  getFirebaseAuth: () => ({
    getUserByEmail: async () => {
      if (!store.authUid) throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' })
      return { uid: store.authUid }
    },
  }),
}))
vi.mock('./workspace-auth', () => ({ invalidateWorkspaceMemberCache: vi.fn((uid: string, w: string) => { store.events.push(`invalidate:${uid}_${w}`) }) }))
vi.mock('./member-line-bind', () => ({
  removeFromHandoffNotify: vi.fn(async (w: string, lineUserId: string) => {
    store.events.push(`notify:${w}:${lineUserId}`)
    return store.notifyFail.has(w) ? 'failed' : 'removed'
  }),
}))
vi.mock('./audit-log', () => ({ writeAuditLog: vi.fn(async (e: { workspaceId: string }) => { store.events.push(`audit:${e.workspaceId}`) }) }))

const tables = { workspaces: () => store.workspaces, workspaceMembers: () => store.members, workspaceInvites: () => store.invites } as Record<string, () => Row[]>
const del = (col: string, id: string) => {
  store.events.push(`delete:${col}:${id}`)
  if (col === 'workspaceMembers') store.members = store.members.filter(r => r.id !== id)
  if (col === 'workspaceInvites') store.invites = store.invites.filter(r => r.id !== id)
}
const query = (col: string, filters: [string, unknown][] = []): any => ({
  where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]]),
  get: async () => ({
    docs: tables[col]!().filter(r => filters.every(([f, v]) => r.data[f] === v))
      .map(r => ({ id: r.id, data: () => r.data, ref: { delete: async () => del(col, r.id) } })),
  }),
})
const db = { collection: (col: string) => query(col) } as never

const { removeOrgMemberFromWorkspaces } = await import('./org-member-cascade')
const run = () => removeOrgMemberFromWorkspaces({ db, orgId: 'orgA', email: 'Ex@X.tw', actorUid: 'boss', note: '被移出組織' })

beforeEach(() => {
  store.workspaces = [
    { id: 'w1', data: { organizationId: 'orgA' } },
    { id: 'w2', data: { organizationId: 'orgA' } },
    { id: 'wX', data: { organizationId: 'orgB' } },
  ]
  store.members = [
    { id: 'u1_w1', data: { uid: 'u1', workspaceId: 'w1', role: 'owner', lineUserId: 'U1' } },
    // uid 對不上（例如換過帳號），但邀請時記下的信箱是他
    { id: 'u9_w2', data: { uid: 'u9', workspaceId: 'w2', role: 'viewer', invitedEmail: 'ex@x.tw' } },
    // ⛔ 別的組織的帳號不動
    { id: 'u1_wX', data: { uid: 'u1', workspaceId: 'wX', role: 'agent' } },
    // ⛔ 別人不動
    { id: 'u2_w1', data: { uid: 'u2', workspaceId: 'w1', role: 'admin' } },
  ]
  store.invites = [
    { id: 'inv-w2', data: { workspaceId: 'w2', email: 'ex@x.tw', role: 'agent' } },
    { id: 'inv-wX', data: { workspaceId: 'wX', email: 'ex@x.tw', role: 'agent' } },
  ]
  store.authUid = 'u1'
  store.notifyFail = new Set()
  store.events = []
})

describe('removeOrgMemberFromWorkspaces', () => {
  it('🔴 這個組織底下的帳號全部移掉（含擁有者、觀察者；uid 與 invitedEmail 兩路都認），⛔ 別的組織、別人不動', async () => {
    const r = await run()
    expect(r.removed.map(x => `${x.uid}_${x.workspaceId}:${x.role}`).sort()).toEqual(['u1_w1:owner', 'u9_w2:viewer'])
    expect(store.members.map(m => m.id).sort()).toEqual(['u1_wX', 'u2_w1'])
    expect(r.failedWorkspaceIds).toEqual([])
  })

  it('🔴 還沒接受的邀請一起收掉（不然他之後登入又自動變回成員），⛔ 只收這個組織的', async () => {
    const r = await run()
    expect(r.invitesDeleted).toBe(1)
    expect(store.invites.map(i => i.id)).toEqual(['inv-wX'])
  })

  it('每個帳號：先從通知名單拿掉 → 再刪成員 → 清快取 → 寫那個帳號自己的操作紀錄', async () => {
    await run()
    const w1 = store.events.filter(e => e.includes('w1') && !e.includes('u2'))
    expect(w1).toEqual(['notify:w1:U1', 'delete:workspaceMembers:u1_w1', 'invalidate:u1_w1', 'audit:w1'])
  })

  it('🔴 通知名單拿不掉的那個帳號 ⛔ 不刪成員、回報失敗（呼叫端據此不刪組織那一筆）', async () => {
    store.notifyFail = new Set(['w1'])
    const r = await run()
    expect(r.failedWorkspaceIds).toEqual(['w1'])
    expect(store.members.some(m => m.id === 'u1_w1')).toBe(true)
    // 其他帳號照樣移（重試時已經移掉的就不在了，冪等）
    expect(store.members.some(m => m.id === 'u9_w2')).toBe(false)
  })

  it('Firebase 查不到這個信箱 → 靠 invitedEmail 那一路照樣移得掉', async () => {
    store.authUid = null
    const r = await run()
    expect(r.removed.map(x => x.workspaceId)).toEqual(['w2'])
  })
})
