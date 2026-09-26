import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 超管給一筆可折抵下期扣款的餘額（`C-267`，2026-09-26 老闆拍板「客戶只看到補了多少」）。
 * 🔴 客戶看得到的操作紀錄**不帶原因**：原因是超管打給自己人看的（「客戶抱怨太多先安撫」），
 *    原本原文照印在客戶自己的操作紀錄頁。原因另記一筆平台層的。
 */

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({ requireSuperAdmin: vi.fn(async () => ({ uid: 'super1' })) }))
vi.mock('~~/server/utils/billing', () => ({ invalidateWorkspaceSubscriptionCache: vi.fn() }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./grant-credit.post')
const { getDb } = await import('~~/server/utils/firebase')
const { writeAuditLog } = await import('~~/server/utils/audit-log')

const created: Record<string, unknown>[] = []
beforeEach(() => {
  vi.mocked(writeAuditLog).mockClear()
  created.length = 0
  vi.mocked(getDb).mockReturnValue({
    collection: () => ({ doc: () => ({}) }),
    runTransaction: async (fn: (tx: unknown) => unknown) => fn({
      get: async () => ({ exists: true, data: () => ({ organizationId: 'o1', subscription: { planId: 'basic', creditBalance: 100 } }) }),
      update: () => {},
      create: (_ref: unknown, d: Record<string, unknown>) => { created.push(d) },
    }),
  } as never)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('POST /api/admin/super/grant-credit', () => {
  it('🔴 客戶那一筆不帶原因；原因只記在平台層那一筆與專帳', async () => {
    body = { workspaceId: 'ws1', amount: 299, reason: '客戶抱怨太多先安撫' }
    await (handler as any)({})
    const calls = vi.mocked(writeAuditLog).mock.calls.map(c => c[0] as Record<string, any>)
    const tenant = calls.find(c => c.workspaceId === 'ws1')
    const platform = calls.find(c => c.scope === 'platform')
    expect(tenant?.note).toBe('平台給了 NT$299 可折抵下期扣款的餘額')
    expect(JSON.stringify(tenant)).not.toContain('安撫')
    expect(platform?.note).toContain('客戶抱怨太多先安撫')
    expect(platform?.targetId).toBe('ws1')
    // 專帳（billingCredits，只有平台的付款頁讀）照樣留原因
    expect(created[0]).toMatchObject({ workspaceId: 'ws1', amount: 299, reason: '客戶抱怨太多先安撫' })
  })

  it('沖銷（負數）也一樣：客戶那一筆只講沖銷了多少', async () => {
    body = { workspaceId: 'ws1', amount: -50, reason: '開錯了' }
    await (handler as any)({})
    const tenant = vi.mocked(writeAuditLog).mock.calls.map(c => c[0] as Record<string, any>).find(c => c.workspaceId === 'ws1')
    expect(tenant?.note).toBe('平台沖銷了 NT$50 可折抵下期扣款的餘額')
  })
})
