import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 組織管理員自己開官方帳號（`G-107`⑰，2026-09-29 權限盤點）：停用即擋收斂在 requireActiveOrgAdmin，
 * 原本用舊版 requireOrgAdmin、停用檢查自己再寫一份。
 */

const { gate } = vi.hoisted(() => ({ gate: { error: null as null | Error } }))

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireActiveOrgAdmin: vi.fn(async () => {
    if (gate.error) throw gate.error
    return { uid: 'u1', email: 'boss@x.tw', isSuperAdmin: false }
  }),
}))
vi.mock('~~/server/utils/workspace-system-modules', () => ({ addSystemModulesToBatch: vi.fn() }))
vi.mock('~~/server/utils/billing', () => ({ defaultFreeSubscription: () => ({ planId: 'free' }) }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/firebase', () => ({
  getDb: () => ({
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => ({ maxWorkspaces: null }) }) }),
    }),
    batch: () => ({ set: () => {}, commit: async () => {} }),
  }),
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => ({ name: '新帳號' }))
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./index.post')
const { requireActiveOrgAdmin } = await import('~~/server/utils/workspace-auth')

beforeEach(() => {
  gate.error = null
  vi.mocked(requireActiveOrgAdmin).mockClear()
})

describe('POST /api/admin/org/:orgId/workspaces', () => {
  it('走 requireActiveOrgAdmin（停用即擋只有一份）', async () => {
    const r = await (handler as any)({ context: { params: { orgId: 'orgA' } } })
    expect(requireActiveOrgAdmin).toHaveBeenCalledWith(expect.anything(), 'orgA')
    expect(r).toMatchObject({ name: '新帳號' })
  })

  it('守門擋下（例如組織停用）→ 原因照原樣往外丟', async () => {
    gate.error = Object.assign(new Error('此組織已停用，請聯繫客服'), { statusCode: 403, statusMessage: '此組織已停用，請聯繫客服' })
    await expect((handler as any)({ context: { params: { orgId: 'orgA' } } }))
      .rejects.toMatchObject({ statusCode: 403, statusMessage: '此組織已停用，請聯繫客服' })
  })
})
