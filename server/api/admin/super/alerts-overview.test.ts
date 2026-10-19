import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 超管「全站異常總覽」端點：「客人傳的圖讀不出來」那一區（`C-164`）。
 * ⛔ 查失敗（多半是索引沒部署）要回 null，不可以回「0 張」——那正是 `C-163` 三週沒人知道的樣子。
 */

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn(() => db) }))
vi.mock('~~/server/utils/workspace-auth', () => ({ requireSuperAdmin: vi.fn(async () => ({ uid: 'super-1' })) }))
vi.mock('~~/server/utils/workspace-alerts', () => ({
  collectWorkspaceAlerts: vi.fn(async () => []),
  MAINTENANCE_STALE_MS: 3600_000,
}))
vi.mock('~~/server/utils/ai-usage', () => ({ getCurrentMonthUsageCounts: vi.fn(async () => ({ invocations: 0, answered: 0, billable: 0 })) }))
vi.mock('~~/server/utils/ai-feedback-events', () => ({
  readMarkDocsByReason: vi.fn(async () => ({ docs: [], truncated: false })),
  pendingMarks: vi.fn(() => []),
  toPendingMarkEvent: vi.fn(),
}))
vi.mock('~~/server/utils/super-alerts-cache', () => ({
  readSuperAlertsCache: vi.fn(() => null),
  writeSuperAlertsCache: vi.fn(),
}))
vi.mock('~~/server/utils/image-read-failures', async orig => ({
  ...(await orig<typeof import('~~/server/utils/image-read-failures')>()),
  readImageReadFailureEvents: vi.fn(),
}))
vi.mock('firebase-admin/firestore', () => ({ Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) } }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => ({}))

const db = {
  collection: (name: string) => {
    const q = {
      doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
      select: () => q,
      limit: () => q,
      where: () => q,
      count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
      get: async () => ({
        size: name === 'workspaces' ? 1 : 0,
        docs: name === 'workspaces' ? [{ id: 'ws1', data: () => ({ name: 'MYFEEL' }) }] : [],
      }),
    }
    return q
  },
}

const { default: handler } = await import('./alerts-overview.get')
const { readImageReadFailureEvents } = await import('~~/server/utils/image-read-failures')
const call = () => (handler as unknown as (e: unknown) => Promise<any>)({})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/admin/super/alerts-overview：客人傳的圖讀不出來', () => {
  it('查得到 → 每個帳號一列，帳號名字對上', async () => {
    vi.mocked(readImageReadFailureEvents).mockResolvedValueOnce({
      events: [{ workspaceId: 'ws1', conversationId: 'ws1_Uabc', atMs: Date.now() - 60_000 }],
      truncated: false,
    })

    const res = await call()

    expect(res.imageReadFailures).toMatchObject({ total: 1, burst: null, truncated: false })
    expect(res.imageReadFailures.workspaces).toEqual([
      expect.objectContaining({ workspaceId: 'ws1', workspaceName: 'MYFEEL', count: 1, lastConversationId: 'ws1_Uabc' }),
    ])
  })

  it('🔴 查不了（索引沒部署）→ null，不是 0 張；其他區照常', async () => {
    vi.mocked(readImageReadFailureEvents).mockRejectedValueOnce(new Error('9 FAILED_PRECONDITION: The query requires an index'))

    const res = await call()

    expect(res.imageReadFailures).toBeNull()
    expect(res.workspaces).toHaveLength(1)
    expect(res.aiMistakes).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })
})
