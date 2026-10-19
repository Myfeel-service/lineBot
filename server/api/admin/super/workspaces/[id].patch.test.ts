import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 超管把帳號搬到別的組織（`G-104`③，2026-09-29 權限盤點）：要清「帳號 → 組織」快取，
 * 不然**舊**組織的管理員在同一台機器上還能再進 60 秒。
 */

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' } }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireSuperAdmin: vi.fn(async () => ({ uid: 'boss' })),
  invalidateWorkspaceOrgCache: vi.fn(),
}))
vi.mock('~~/server/utils/billing', () => ({ invalidateWorkspaceSubscriptionCache: vi.fn() }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

let body: Record<string, unknown> = {}
const ref = {
  get: async () => ({
    exists: true,
    data: () => ({
      name: '一號店',
      channelAccessToken: 'line-access-token-secret',
      channelSecret: 'line-channel-secret',
      subscription: { planId: 'starter', status: 'active', autoRenew: true, payuniCardToken: 'real-credit-hash', payuniCardLast4: '1234' },
    }),
  }),
}
vi.stubGlobal('getDb', () => ({
  collection: () => ({ doc: () => ref }),
  runTransaction: async (fn: (tx: unknown) => unknown) => fn({ get: () => ref.get(), update: () => {} }),
}))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'w1')
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./[id].patch')
const { invalidateWorkspaceOrgCache } = await import('~~/server/utils/workspace-auth')

beforeEach(() => vi.mocked(invalidateWorkspaceOrgCache).mockClear())

describe('PATCH /api/admin/super/workspaces/:id', () => {
  it('🔴 改了所屬組織 → 清帳號→組織快取', async () => {
    body = { organizationId: 'orgB' }
    await (handler as any)({})
    expect(invalidateWorkspaceOrgCache).toHaveBeenCalledWith('w1')
  })

  it('只改名稱 → 不用清', async () => {
    body = { name: '新名字' }
    await (handler as any)({})
    expect(invalidateWorkspaceOrgCache).not.toHaveBeenCalled()
  })

  it('🔴 回傳不帶 LINE 憑證、也不帶真的扣款卡片代碼（`B-51`：以前整份文件回到瀏覽器）', async () => {
    body = { name: '新名字' }
    const res = await (handler as any)({})
    const text = JSON.stringify(res)
    expect(text).not.toContain('line-access-token-secret')
    expect(text).not.toContain('line-channel-secret')
    expect(text).not.toContain('real-credit-hash')
    // 有沒有綁卡、末四碼照樣看得到（改方案確認框靠它判斷會不會被自動扣款）
    expect(res.subscription).toMatchObject({ planId: 'starter', payuniCardLast4: '1234' })
    expect(Boolean(res.subscription.payuniCardToken)).toBe(true)
  })
})
