import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 守門本身（`G-99`／`G-101`①／`G-104`①②③，2026-09-29 權限盤點）。
 * 這支之前沒有任何測試直接打——其他端點測試都把整個 workspace-auth mock 掉。
 */

type Row = { id: string, data: Record<string, unknown> }

const { store, auth } = vi.hoisted(() => ({
  store: {
    members: {} as Record<string, Record<string, unknown>>,
    workspaces: {} as Record<string, Record<string, unknown>>,
    orgs: {} as Record<string, Record<string, unknown>>,
    orgMembers: [] as { id: string, data: Record<string, unknown> }[],
    /** orgMembers 被查了幾次（直接管理員的每一支 API 不該多這一次） */
    orgQueries: 0,
    invites: [] as { id: string, data: Record<string, unknown> }[],
  },
  auth: {
    decoded: null as Record<string, unknown> | null,
    revoked: false,
    calls: [] as boolean[],
  },
}))

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('./firebase', () => {
  const docRef = (map: () => Record<string, Record<string, unknown>>, id: string) => ({
    id,
    get: async () => ({ exists: id in map(), data: () => map()[id] }),
  })
  const query = (rows: () => Row[], filters: [string, unknown][] = []): any => ({
    where: (f: string, _op: string, v: unknown) => query(rows, [...filters, [f, v]]),
    limit: () => query(rows, filters),
    get: async () => {
      const docs = rows()
        .filter(r => filters.every(([f, v]) => r.data[f] === v))
        .map(r => ({
          id: r.id,
          ref: { id: r.id, delete: async () => { store.invites = store.invites.filter(i => i.id !== r.id) } },
          data: () => r.data,
        }))
      return { docs, empty: docs.length === 0, size: docs.length }
    },
  })
  const db = {
    collection: (name: string) => {
      if (name === 'workspaceMembers') return { doc: (id: string) => docRef(() => store.members, id) }
      if (name === 'workspaces') return { doc: (id: string) => docRef(() => store.workspaces, id) }
      if (name === 'organizations') return { doc: (id: string) => docRef(() => store.orgs, id) }
      if (name === 'orgMembers') return query(() => { store.orgQueries++; return store.orgMembers })
      if (name === 'workspaceInvites') return query(() => store.invites)
      throw new Error(`unexpected collection ${name}`)
    },
    runTransaction: async (fn: (tx: unknown) => unknown) => fn({
      get: (ref: { get: () => unknown }) => ref.get(),
      set: (ref: { id: string }, data: Record<string, unknown>) => { store.members[ref.id] = data },
      delete: (ref: { delete: () => unknown }) => ref.delete(),
    }),
  }
  return {
    getDb: () => db,
    getFirebaseAuth: () => ({
      verifyIdToken: async (_token: string, checkRevoked?: boolean) => {
        auth.calls.push(checkRevoked === true)
        if (!auth.decoded) throw new Error('bad token')
        if (checkRevoked && auth.revoked) throw Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' })
        return auth.decoded
      },
    }),
  }
})

vi.stubGlobal('getHeader', (e: { headers: Record<string, string> }, name: string) => e.headers[name.toLowerCase()])
vi.stubGlobal('getQuery', (e: { query?: Record<string, string> }) => e.query ?? {})
vi.stubGlobal('readBody', async (e: { body?: unknown }) => e.body)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const ev = (o: { workspaceId?: string } = {}) => ({
  headers: { authorization: 'Bearer t' },
  context: { params: {} },
  query: o.workspaceId ? { workspaceId: o.workspaceId } : {},
}) as never

let mod: typeof import('./workspace-auth')

beforeEach(async () => {
  // 快取是模組層級的：每個 case 重新載入，才不會吃到上一個 case 的結果
  vi.resetModules()
  mod = await import('./workspace-auth')
  store.members = {}
  store.workspaces = { w1: { organizationId: 'orgA' } }
  store.orgs = { orgA: { disabled: false }, orgB: { disabled: false } }
  store.orgMembers = [{ id: 'om1', data: { orgId: 'orgA', email: 'boss@x.tw', role: 'admin' } }]
  store.orgQueries = 0
  store.invites = []
  auth.decoded = null
  auth.revoked = false
  auth.calls = []
})

const user = (extra: Record<string, unknown> = {}) => { auth.decoded = { uid: 'u1', ...extra } }

describe('trustedEmail（`G-99`）', () => {
  it('只有 email_verified === true 才回，並正規化成小寫', () => {
    expect(mod.trustedEmail({ email: ' Boss@X.tw ', email_verified: true } as never)).toBe('boss@x.tw')
    expect(mod.trustedEmail({ email: 'boss@x.tw', email_verified: false } as never)).toBeNull()
    expect(mod.trustedEmail({ email: 'boss@x.tw' } as never)).toBeNull()
    expect(mod.trustedEmail({ email_verified: true } as never)).toBeNull()
  })
})

describe('email 認人的三條路都只認驗證過的信箱（`G-99`）', () => {
  it('🔴 組織管理員：信箱沒驗證 → 403；驗證過（大小寫不同也認）→ admin', async () => {
    user({ email: 'boss@x.tw', email_verified: false })
    await expect(mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }))).rejects.toMatchObject({ statusCode: 403 })

    vi.resetModules()
    mod = await import('./workspace-auth')
    user({ email: 'Boss@X.tw', email_verified: true })
    const ctx = await mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }), 'admin')
    expect(ctx).toMatchObject({ role: 'admin', isOrgAdmin: true })
  })

  it('🔴 email 邀請：信箱沒驗證 → 不轉正、邀請留著', async () => {
    store.invites = [{ id: 'inv1', data: { workspaceId: 'w1', email: 'new@x.tw', role: 'agent', expiresAt: Date.now() + 60_000 } }]
    user({ email: 'new@x.tw', email_verified: false })
    await expect(mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }))).rejects.toMatchObject({ statusCode: 403 })
    expect(store.members['u1_w1']).toBeUndefined()
    expect(store.invites).toHaveLength(1)
  })

  it('email 邀請：驗證過 → 轉成成員', async () => {
    store.invites = [{ id: 'inv1', data: { workspaceId: 'w1', email: 'new@x.tw', role: 'agent', expiresAt: Date.now() + 60_000 } }]
    user({ email: 'new@x.tw', email_verified: true })
    const ctx = await mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }))
    expect(ctx.role).toBe('agent')
    expect(store.members['u1_w1']).toMatchObject({ role: 'agent', invitedEmail: 'new@x.tw' })
  })

  it('🔴 過期的邀請（`G-107`⑥）→ 不轉正，⛔ 也不刪（成員頁要顯示「已過期」）；同信箱還有效的那張照樣轉正', async () => {
    store.invites = [{ id: 'old', data: { workspaceId: 'w1', email: 'new@x.tw', role: 'admin', expiresAt: Date.now() - 1 } }]
    user({ email: 'new@x.tw', email_verified: true })
    await expect(mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }))).rejects.toMatchObject({ statusCode: 403 })
    expect(store.invites.map(i => i.id)).toEqual(['old'])

    store.invites.push({ id: 'fresh', data: { workspaceId: 'w1', email: 'new@x.tw', role: 'agent', expiresAt: Date.now() + 60_000 } })
    expect((await mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }))).role).toBe('agent')
    expect(store.invites.map(i => i.id)).toEqual(['old'])
  })

  it('⭐ uid 直接掛的成員不受影響（信箱沒驗證照樣進得去）', async () => {
    store.members['u1_w1'] = { role: 'agent' }
    user({ email: 'someone@x.tw', email_verified: false })
    expect((await mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }))).role).toBe('agent')
  })

  it('requireOrgAdmin／requireAuth 也一樣', async () => {
    user({ email: 'boss@x.tw', email_verified: false })
    await expect(mod.requireOrgAdmin(ev(), 'orgA')).rejects.toMatchObject({ statusCode: 403 })
    expect((await mod.requireAuth(ev())).email).toBeNull()
  })
})

describe('組織管理員同時是直接成員：取較高的（`G-101`①）', () => {
  it('🔴 直接成員是觀察者、又是組織管理員 → admin', async () => {
    store.members['u1_w1'] = { role: 'viewer' }
    user({ email: 'boss@x.tw', email_verified: true })
    const ctx = await mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }), 'admin')
    expect(ctx).toMatchObject({ role: 'admin', isOrgAdmin: true })
  })

  it('直接成員已經是擁有者 → 不會被組織管理員身分往下拉；要 isOrgAdmin 的端點照實拿到（`G-96` 靠它判斷能不能動擁有者）', async () => {
    store.members['u1_w1'] = { role: 'owner' }
    user({ email: 'boss@x.tw', email_verified: true })
    expect(await mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }), 'viewer', { withOrgAdmin: true }))
      .toMatchObject({ role: 'owner', isOrgAdmin: true })
    expect(await mod.requireCapability(ev({ workspaceId: 'w1' }), 'members.manage', { withOrgAdmin: true }))
      .toMatchObject({ role: 'owner', isOrgAdmin: true })
  })

  it('不是組織管理員的直接管理員 → isOrgAdmin=false', async () => {
    store.members['u1_w1'] = { role: 'admin' }
    user({ email: 'someone@x.tw', email_verified: true })
    expect(await mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }), 'viewer', { withOrgAdmin: true }))
      .toMatchObject({ role: 'admin', isOrgAdmin: false })
  })

  it('⭐ 直接管理員／擁有者的一般 API 不多查組織（2026-09-30 code review：以前每一支都多一次）；isOrgAdmin 保守回 false', async () => {
    store.members['u1_w1'] = { role: 'owner' }
    user({ email: 'boss@x.tw', email_verified: true })
    expect(await mod.requireCapability(ev({ workspaceId: 'w1' }), 'ai.read')).toMatchObject({ role: 'owner', isOrgAdmin: false })
    expect(store.orgQueries).toBe(0)
  })

  it('直接角色還不到管理員 → 照樣查（組織管理員要能把他拉高，`G-101`①不能因為省查詢就退回去）', async () => {
    store.members['u1_w1'] = { role: 'agent' }
    user({ email: 'boss@x.tw', email_verified: true })
    expect(await mod.requireCapability(ev({ workspaceId: 'w1' }), 'ai.read')).toMatchObject({ role: 'admin', isOrgAdmin: true })
    expect(store.orgQueries).toBe(1)
  })

  it('⛔ 用 isOrgAdmin 做判斷的端點一定要帶 withOrgAdmin（沒帶＝直接管理員那條路永遠拿到 false）', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = fileURLToPath(new URL('../api', import.meta.url))
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.ts') && !p.includes('.test.') ? [p] : [])
    })
    const users = walk(root).filter(f => /\bisOrgAdmin\b/.test(readFileSync(f, 'utf8')))
    expect(users.length).toBeGreaterThan(0) // 那兩支成員端點——一支都找不到＝這條規則在空轉
    const missing = users.filter(f => !/withOrgAdmin:\s*true/.test(readFileSync(f, 'utf8')))
    expect(missing).toEqual([])
  })
})

describe('超管（`G-104`①②）', () => {
  it('🔴 沒帶 workspaceId → 400（原本回空字串，下游就變成全站範圍）', async () => {
    user({ superAdmin: true })
    await expect(mod.requireWorkspaceAccess(ev())).rejects.toMatchObject({ statusCode: 400 })
    expect(await mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }))).toMatchObject({ workspaceId: 'w1', role: 'owner', isSuperAdmin: true })
  })

  it('🔴 超管那條路會查撤銷（checkRevoked）；被撤銷 → 401', async () => {
    user({ superAdmin: true })
    await mod.requireSuperAdmin(ev())
    expect(auth.calls).toEqual([false, true])

    auth.revoked = true
    await expect(mod.requireSuperAdmin(ev())).rejects.toMatchObject({ statusCode: 401 })
    await expect(mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('一般使用者不多打那一次（每個請求都 checkRevoked 太貴）', async () => {
    store.members['u1_w1'] = { role: 'agent' }
    user()
    auth.revoked = true
    await mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }))
    expect(auth.calls).toEqual([false])
  })
})

describe('requireActiveOrgAdmin（`G-107`⑰ 開帳號那支改用它）', () => {
  it('組織停用 → 組織管理員 403「此組織已停用」；超管照樣放行', async () => {
    store.orgs.orgA = { disabled: true }
    user({ email: 'boss@x.tw', email_verified: true })
    await expect(mod.requireActiveOrgAdmin(ev(), 'orgA')).rejects.toMatchObject({ statusCode: 403, statusMessage: '此組織已停用，請聯繫客服' })

    user({ superAdmin: true })
    await expect(mod.requireActiveOrgAdmin(ev(), 'orgA')).resolves.toMatchObject({ isSuperAdmin: true })
  })
})

describe('帳號換組織要清快取（`G-104`③）', () => {
  it('🔴 超管把 w1 搬到別的組織 → 清掉之後舊組織的管理員當場進不去', async () => {
    user({ email: 'boss@x.tw', email_verified: true })
    await mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }))

    store.workspaces.w1 = { organizationId: 'orgB' }
    // 沒清：還吃著 60 秒的舊對應（這就是原本的洞）
    await expect(mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }))).resolves.toMatchObject({ role: 'admin' })

    mod.invalidateWorkspaceOrgCache('w1')
    await expect(mod.requireWorkspaceAccess(ev({ workspaceId: 'w1' }))).rejects.toMatchObject({ statusCode: 403 })
  })
})
