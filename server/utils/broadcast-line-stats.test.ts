import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { fromMillis: (m: number) => ({ toMillis: () => m }) },
}))
vi.mock('~~/server/utils/broadcast-line-insight', () => ({ fetchBroadcastLineInsight: vi.fn() }))

import { fetchBroadcastLineInsight } from '~~/server/utils/broadcast-line-insight'
import { snapshotBroadcastLineStats } from './broadcast-line-stats'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 11, 4)
const ts = (ms: number) => ({ toDate: () => new Date(ms) })

type Row = { id: string, data: Record<string, unknown> }
function fakeDb(rows: Row[]) {
  const updates: { id: string, patch: Record<string, unknown> }[] = []
  const db = {
    collection: () => ({
      where: () => ({
        select: () => ({
          limit: () => ({
            get: async () => ({
              size: rows.length,
              docs: rows.map(r => ({
                data: () => r.data,
                ref: { id: r.id, update: async (patch: Record<string, unknown>) => { updates.push({ id: r.id, patch }) } },
              })),
            }),
          }),
        }),
      }),
    }),
  }
  return { db: db as never, updates }
}

const row = (id: string, ageDays: number, over: Record<string, unknown> = {}): Row => ({
  id,
  data: { workspaceId: 'ws', status: 'completed', sentCount: 100, startedAt: ts(NOW - ageDays * DAY), completedAt: ts(NOW - ageDays * DAY), lineAggregationUnit: `u-${id}`, ...over },
})

beforeEach(() => {
  vi.mocked(fetchBroadcastLineInsight).mockReset()
  vi.mocked(fetchBroadcastLineInsight).mockResolvedValue({ lineUniqueImpression: 40, lineUniqueClick: 21 })
})

describe('snapshotBroadcastLineStats', () => {
  it('問到的人數存進推播那一筆，輪次照發完幾天算', async () => {
    const { db, updates } = fakeDb([row('a', 3.5)])
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(updates).toEqual([{ id: 'a', patch: { lineStats: { opened: 40, clicked: 21, round: 2, fetchedAt: NOW } } }])
    expect(r).toMatchObject({ due: 1, calls: 1, written: 1, failed: 0, deferred: 0 })
  })

  it('⛔ 一輪最多問 LINE 6 次，排不到的要講還剩幾則（不靜靜丟掉）；最舊的先做', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(`b${i}`, 2 + i))
    const { db, updates } = fakeDb(rows)
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(vi.mocked(fetchBroadcastLineInsight)).toHaveBeenCalledTimes(6)
    expect(r).toMatchObject({ due: 9, calls: 6, written: 6, deferred: 3 })
    // 最舊的（第 10 天那則）最快就要查不到了，排第一個
    expect(updates[0]!.id).toBe('b8')
  })

  it('發送時沒帶統計標記的：記一筆就不再問，⛔ 不花 LINE 的查詢次數', async () => {
    const { db, updates } = fakeDb([row('x', 2, { lineInsightAggregationApplied: false })])
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(vi.mocked(fetchBroadcastLineInsight)).not.toHaveBeenCalled()
    expect(updates[0]!.patch).toEqual({ lineStats: { opened: null, clicked: null, round: 3, fetchedAt: NOW, unavailable: true } })
    expect(r.calls).toBe(0)
  })

  it('問失敗：留著上一輪的數字、⛔ 不推進輪次，記下原因', async () => {
    vi.mocked(fetchBroadcastLineInsight).mockResolvedValue({ lineUniqueImpression: null, lineUniqueClick: null, lineInsightError: '429 too many' })
    const { db, updates } = fakeDb([row('e', 3.5, { lineStats: { opened: 30, clicked: 10, round: 1, fetchedAt: 1 } })])
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(updates[0]!.patch).toEqual({ lineStats: { opened: 30, clicked: 10, round: 1, fetchedAt: 1, errorAt: NOW, error: '429 too many' } })
    expect(r.failed).toBe(1)
  })

  it('還沒送完、沒送到人、還沒到第 1 天、問過了的都不碰', async () => {
    const { db, updates } = fakeDb([
      row('draft', 3, { status: 'scheduled' }),
      row('zero', 3, { sentCount: 0 }),
      row('fresh', 0.5),
      row('done', 8, { lineStats: { opened: 1, clicked: 1, round: 3, fetchedAt: 1 } }),
    ])
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(updates).toEqual([])
    expect(r.due).toBe(0)
  })
})
