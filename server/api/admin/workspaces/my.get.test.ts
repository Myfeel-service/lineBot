import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 帳號選擇頁的清單（2026-09-29 權限盤點）：角色算法必須跟守門（requireWorkspaceAccess）一模一樣。
 * - `G-101`①：組織管理員同時是直接成員時，原本清單上寫的是比較低的那個
 * - `G-107`⑦：email 沒轉小寫，大小寫不同時清單跟實際權限對不上
 * - `G-99`：沒驗證過的信箱不認（組織管理員、email 邀請都不列）
 */

const { tables, token } = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, Record<string, unknown>>>,
  token: { decoded: {} as Record<string, unknown> },
}))

vi.mock('~~/server/utils/firebase', () => ({ getFirebaseAuth: vi.fn(), getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~~/server/utils/workspace-auth')>()),
  verifyRequestToken: vi.fn(async () => token.decoded),
}))

const snap = (col: string, id: string) => {
  const d = tables[col]?.[id]
  return { id, exists: d !== undefined, data: () => d }
}
const query = (col: string, filters: [string, unknown][] = []): any => ({
  where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]]),
  get: async () => ({
    docs: Object.entries(tables[col] ?? {})
      .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
      .map(([id]) => snap(col, id)),
  }),
})
vi.stubGlobal('getDb', () => ({
  collection: (col: string) => ({
    ...query(col),
    doc: (id: string) => ({ col, id, get: async () => snap(col, id) }),
  }),
  getAll: async (...refs: { col: string, id: string }[]) => refs.map(r => snap(r.col, r.id)),
}))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./my.get')
const run = async () => (await (handler as any)({})) as { workspaces: any[], orgAdminOf: any[] }

beforeEach(() => {
  tables.workspaceMembers = { u1_w1: { uid: 'u1', workspaceId: 'w1', role: 'viewer', organizationId: 'orgA' } }
  tables.workspaces = {
    w1: { name: '一號店', organizationId: 'orgA' },
    w2: { name: '二號店', organizationId: 'orgA' },
  }
  tables.organizations = { orgA: { name: 'A 組織' } }
  tables.orgMembers = { om1: { orgId: 'orgA', email: 'boss@x.tw', role: 'admin' } }
  tables.workspaceInvites = {}
})

describe('GET /api/admin/workspaces/my', () => {
  it('🔴 直接成員是觀察者、又是組織管理員 → 清單上是 admin（跟守門一致）', async () => {
    token.decoded = { uid: 'u1', email: 'boss@x.tw', email_verified: true }
    const { workspaces } = await run()
    expect(workspaces.find(w => w.workspaceId === 'w1')).toMatchObject({ role: 'admin', viaOrgAdmin: true })
    expect(workspaces.find(w => w.workspaceId === 'w2')).toMatchObject({ role: 'admin', viaOrgAdmin: true })
    // 同一個帳號不會列兩次
    expect(workspaces.filter(w => w.workspaceId === 'w1')).toHaveLength(1)
  })

  it('🔴 token 的 email 大小寫不同 → 照樣認得組織管理員（`G-107`⑦）', async () => {
    token.decoded = { uid: 'u1', email: 'Boss@X.tw', email_verified: true }
    const { orgAdminOf } = await run()
    expect(orgAdminOf).toEqual([{ id: 'orgA', name: 'A 組織' }])
  })

  it('email 邀請：還有效的列出來，過期的 ⛔ 不列（點進去只會被擋，`G-107`⑥）', async () => {
    tables.orgMembers = {}
    tables.workspaces = { ...tables.workspaces, w3: { name: '三號店' }, w4: { name: '四號店' } }
    tables.workspaceInvites = {
      live: { workspaceId: 'w3', email: 'new@x.tw', role: 'agent', expiresAt: Date.now() + 60_000 },
      dead: { workspaceId: 'w4', email: 'new@x.tw', role: 'agent', expiresAt: Date.now() - 60_000 },
    }
    token.decoded = { uid: 'u9', email: 'new@x.tw', email_verified: true }
    const { workspaces } = await run()
    expect(workspaces.map(w => w.workspaceId)).toEqual(['w3'])
  })

  it('🔴 信箱沒驗證 → 不列組織管理員、不列 email 邀請；uid 直接掛的照列（`G-99`）', async () => {
    tables.workspaceInvites = { inv1: { workspaceId: 'w2', email: 'boss@x.tw', role: 'agent' } }
    token.decoded = { uid: 'u1', email: 'boss@x.tw', email_verified: false }
    const { workspaces, orgAdminOf } = await run()
    expect(orgAdminOf).toEqual([])
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]).toMatchObject({ workspaceId: 'w1', role: 'viewer', viaOrgAdmin: false })
  })
})
