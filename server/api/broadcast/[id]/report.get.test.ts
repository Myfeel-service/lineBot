import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 推播成效頁的 LINE 人數（`D-121`／`C-301`，2026-10-12 審查）：
 *   ① 發完超過一個月的，LINE 用現在的查法一定查不到——⛔ 不可以每打開一次就去問一次
 *      （LINE 的統計查詢有次數上限，而且跟發完後自動存人數的排程共用）
 *   ② 一個月內的照舊現場問 LINE（數字比存下來的新）
 *   ③ 現場問不到時改用排程存下來的那一份
 */

const WS = 'ws1'
const DAY = 86_400_000

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS })),
}))
vi.mock('~~/server/utils/broadcast-line-insight', () => ({ fetchBroadcastLineInsight: vi.fn() }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'bc1')
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./report.get')
const { getDb } = await import('~~/server/utils/firebase')
const { fetchBroadcastLineInsight } = await import('~~/server/utils/broadcast-line-insight')
const mockFetch = vi.mocked(fetchBroadcastLineInsight)

const ts = (ms: number) => ({ toDate: () => new Date(ms) })

function useDoc(doc: Record<string, unknown>) {
  const empty = { size: 0, docs: [] }
  const query: any = { where: () => query, limit: () => query, get: async () => empty }
  vi.mocked(getDb).mockReturnValue({
    collection: (name: string) => (name === 'broadcastClickLogs'
      ? query
      : { doc: () => ({ get: async () => ({ exists: true, data: () => doc }), collection: () => query }) }),
  } as never)
}

function sentDaysAgo(days: number, over: Record<string, unknown> = {}) {
  const at = Date.now() - days * DAY
  return {
    workspaceId: WS,
    name: '小滑手_開賣',
    status: 'completed',
    totalCount: 2200,
    sentCount: 2187,
    failedCount: 0,
    skippedCount: 0,
    startedAt: ts(at - 60_000),
    completedAt: ts(at),
    lineAggregationUnit: 'u-bc1',
    lineInsightAggregationApplied: true,
    ...over,
  }
}

const run = () => (handler as unknown as (e: unknown) => Promise<Record<string, any>>)({})

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue({ lineUniqueImpression: 785, lineUniqueClick: 443 })
})

describe('GET /api/broadcast/:id/report — LINE 人數', () => {
  it('一個月內：照舊現場問 LINE', async () => {
    useDoc(sentDaysAgo(3))
    const r = await run()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ lineUniqueImpression: 785, lineUniqueClick: 443, lineStatsStoredAt: null, lineStatsExpired: false })
  })

  it('⛔ 發完超過一個月：不問 LINE，直接用存下來的那一份', async () => {
    useDoc(sentDaysAgo(40, { lineStats: { opened: 612, clicked: 198, round: 3, fetchedAt: 123 } }))
    const r = await run()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(r).toMatchObject({ lineUniqueImpression: 612, lineUniqueClick: 198, lineStatsStoredAt: 123, lineStatsExpired: true })
  })

  it('⛔ 發完超過一個月、也沒存到：不問 LINE，照實講查不到（畫面換成「超過一個月」那句）', async () => {
    useDoc(sentDaysAgo(40))
    const r = await run()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(r.lineUniqueImpression).toBeNull()
    expect(r.lineStatsExpired).toBe(true)
    expect(r.lineInsightError).toBeTruthy()
  })

  it('一個月內但 LINE 一時回錯誤：改用存下來的那一份', async () => {
    mockFetch.mockResolvedValue({ lineUniqueImpression: null, lineUniqueClick: null, lineInsightError: '429 too many' })
    useDoc(sentDaysAgo(10, { lineStats: { opened: 600, clicked: 190, round: 3, fetchedAt: 456 } }))
    const r = await run()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ lineUniqueImpression: 600, lineUniqueClick: 190, lineStatsStoredAt: 456 })
    expect(r.lineInsightError).toBeUndefined()
  })
})
