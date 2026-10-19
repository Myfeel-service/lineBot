import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `D-131`：方案不含這種推播就**排不進去**。
 *
 * 以前排得進去、到了排定時間才在送出端失敗——那時人多半不在電腦前，隔天只看得到「失敗」；
 * 中間還會卡在「發送中」十分鐘等看門狗收殮。排程中的推播按「儲存變更」（PUT）是同一條路，一起驗。
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  // 角色要帶：PUT 排程中的推播另外要送出權限（`C-352`②），客服（agent）有
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'u1', role: 'agent', isSuperAdmin: false })),
}))
vi.mock('~~/server/utils/audit-log', () => ({
  writeAuditLog: vi.fn(async () => {}),
  auditTimeText: vi.fn(() => null),
  auditSnapshot: vi.fn(() => ({})),
  diffChangedFields: vi.fn(() => ({ changedKeys: [], before: {}, after: {} })),
}))
vi.mock('~~/server/utils/billing', () => ({ getWorkspacePlan: vi.fn(async () => null) }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'bc1')
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: scheduleHandler } = await import('./schedule.post')
const { default: putHandler } = await import('../[id].put')
const { getDb } = await import('~~/server/utils/firebase')
const { getWorkspacePlan } = await import('~~/server/utils/billing')
const { BILLING_PLANS, broadcastLockText } = await import('~~/shared/billing/plans')

const FUTURE = new Date(Date.now() + 3 * 86400_000).toISOString()

function makeDb(current: Record<string, unknown>) {
  const update = vi.fn(async () => {})
  vi.mocked(getDb).mockReturnValue({
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ get: vi.fn(async () => ({ exists: true, data: () => current })), update })),
    })),
  } as any)
  return update
}

const draft = (audienceSource: Record<string, unknown>, status = 'draft') =>
  ({ workspaceId: WS, status, name: '週末快閃', audienceSource, messages: [{ type: 'text', text: 'hi' }] })

beforeEach(() => {
  vi.mocked(getWorkspacePlan).mockReset().mockResolvedValue(null)
  body = {}
})

describe('確認排程：方案不含這種推播就排不進去', () => {
  it('輕量方案排一則依標籤的推播 → 403，句子是推播頁那一句，⛔ 一個字都沒寫進去', async () => {
    const update = makeDb(draft({ type: 'tags', tagIds: ['t1'] }))
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.lite)
    body = { scheduleAt: FUTURE }

    await expect((scheduleHandler as any)({})).rejects.toMatchObject({ statusCode: 403, statusMessage: broadcastLockText('basic') })
    expect(update).not.toHaveBeenCalled()
  })

  it('看的是這次帶來的對象：存著的是全部好友、這次改成匯入名單 → 一樣擋', async () => {
    const update = makeDb(draft({ type: 'all' }))
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.starter)
    body = { scheduleAt: FUTURE, audienceSource: { type: 'import', importedUserIds: ['U1'] } }

    await expect((scheduleHandler as any)({})).rejects.toMatchObject({ statusCode: 403 })
    expect(update).not.toHaveBeenCalled()
  })

  it('輕量方案排全部好友、成長方案排依標籤 → 排得進去', async () => {
    let update = makeDb(draft({ type: 'all' }))
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.lite)
    body = { scheduleAt: FUTURE }
    await expect((scheduleHandler as any)({})).resolves.toMatchObject({ status: 'scheduled' })
    expect(update).toHaveBeenCalledTimes(1)

    update = makeDb(draft({ type: 'tags', tagIds: ['t1'] }))
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.growth)
    await expect((scheduleHandler as any)({})).resolves.toMatchObject({ status: 'scheduled' })
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('儲存排程中的推播（PUT）：存完還是排程，就要發得了', () => {
  it('排程中的推播把對象改成依標籤 → 403、不寫入', async () => {
    const update = makeDb(draft({ type: 'all' }, 'scheduled'))
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.lite)
    body = { audienceSource: { type: 'tags', tagIds: ['t1'] }, scheduleAt: FUTURE }

    await expect((putHandler as any)({})).rejects.toMatchObject({ statusCode: 403, statusMessage: broadcastLockText('basic') })
    expect(update).not.toHaveBeenCalled()
  })

  it('⛔ 存草稿不擋：草稿不會送出任何東西（小幫手擬的、從好友頁帶過來的都要存得起來）', async () => {
    const update = makeDb(draft({ type: 'all' }))
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.free)
    body = { audienceSource: { type: 'tags', tagIds: ['t1'] }, scheduleAt: null }

    await expect((putHandler as any)({})).resolves.toMatchObject({ status: 'draft' })
    expect(update).toHaveBeenCalledTimes(1)
  })
})
