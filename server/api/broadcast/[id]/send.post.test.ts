import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `D-131`：立即發送時，方案不含這種推播要在**認領之前**就擋。
 *
 * 送出端（`executeBroadcastSend`）也會擋，但那時推播已經被標成「發送中」，擋下來就變成「失敗」，
 * 草稿要先「重設為草稿」才能改。在端點先擋，草稿原封不動，改個對象就能再按。
 */

const WS = 'ws1'

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn(() => ({})), getDoc: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'u1' })),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/broadcast-send', () => ({ executeBroadcastSend: vi.fn() }))
vi.mock('~~/server/utils/billing', () => ({ getWorkspacePlan: vi.fn(async () => null) }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'bc1')
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./send.post')
const { getDoc } = await import('~~/server/utils/firebase')
const { executeBroadcastSend } = await import('~~/server/utils/broadcast-send')
const { getWorkspacePlan } = await import('~~/server/utils/billing')
const { BILLING_PLANS, broadcastLockText } = await import('~~/shared/billing/plans')

const draft = (audienceSource: Record<string, unknown>) =>
  ({ workspaceId: WS, status: 'draft', name: '週末快閃', audienceSource, messages: [{ type: 'text', text: 'hi' }] })

beforeEach(() => {
  vi.mocked(getWorkspacePlan).mockReset().mockResolvedValue(null)
  vi.mocked(executeBroadcastSend).mockReset().mockResolvedValue({
    success: true, campaignId: 'bc1', totalCount: 2, sentCount: 2, failedCount: 0, postSendError: null, allFailed: false,
  })
})

describe('立即發送：方案不含這種推播，認領之前就擋', () => {
  it('入門方案發依標籤 → 403、推播頁那一句，⛔ 送出流程一步都沒走（草稿不會被標成失敗）', async () => {
    vi.mocked(getDoc).mockResolvedValue(draft({ type: 'tags', tagIds: ['t1'] }) as any)
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.starter)

    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 403, statusMessage: broadcastLockText('basic') })
    expect(executeBroadcastSend).not.toHaveBeenCalled()
  })

  it('免費方案發全部好友 → 403；輕量方案發全部好友 → 照常送', async () => {
    vi.mocked(getDoc).mockResolvedValue(draft({ type: 'all' }) as any)
    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.free)
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 403, statusMessage: broadcastLockText('none') })
    expect(executeBroadcastSend).not.toHaveBeenCalled()

    vi.mocked(getWorkspacePlan).mockResolvedValue(BILLING_PLANS.lite)
    await expect((handler as any)({})).resolves.toMatchObject({ success: true, sentCount: 2 })
    expect(executeBroadcastSend).toHaveBeenCalledTimes(1)
  })
})
