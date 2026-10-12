import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { fromMillis: (m: number) => ({ toMillis: () => m, toDate: () => new Date(m) }) },
  FieldValue: { delete: () => '__delete__' },
  FieldPath: { documentId: () => '__name__' },
}))
vi.mock('~~/server/utils/broadcast-line-insight', () => ({ fetchBroadcastLineInsight: vi.fn() }))

import { fetchBroadcastLineInsight } from '~~/server/utils/broadcast-line-insight'
import { lineStatsNextDueAt, LINE_STATS_RETRY_MS } from '~~/shared/broadcast-line-stats'
import { snapshotBroadcastLineStats } from './broadcast-line-stats'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 11, 4)
const LEGACY_DOC = 'broadcast-line-stats-legacy'
const ts = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) })

type Data = Record<string, any>
type Key = { kind: 'num' | 'ts' | 'str', n: number | string } | null

/** 比較用：Firestore 只拿同一種型別的值互相比（數字跟時間戳記不會互相比到） */
function keyOf(v: unknown): Key {
  if (typeof v === 'number') return { kind: 'num', n: v }
  if (typeof v === 'string') return { kind: 'str', n: v }
  if (v && typeof (v as { toMillis?: unknown }).toMillis === 'function') return { kind: 'ts', n: (v as { toMillis: () => number }).toMillis() }
  return null
}
function cmp(a: Key, b: Key): number | null {
  if (!a || !b || a.kind !== b.kind) return null
  return a.n < b.n ? -1 : a.n > b.n ? 1 : 0
}

/**
 * 假 Firestore，照真的規則：
 * - 有不等式又沒寫 orderBy 時，隱含照那個欄位由小到大排（⚠️ 舊版「不排序」其實就是最舊的先回）
 * - 最後一律照文件 id 排；orderBy／where 的欄位不存在的文件不會出現
 * - 讀取次數：每回傳一份文件算一次，空查詢也算一次
 */
function fakeDb(rows: { id: string, data: Data }[], opts: { legacy?: Data | null } = {}) {
  const store = new Map(rows.map(r => [r.id, { ...r.data }]))
  const cron = new Map<string, Data>()
  if (opts.legacy !== null) cron.set(LEGACY_DOC, opts.legacy ?? { doneAt: 1 })
  const log = { reads: 0, broadcastQueries: [] as string[], updates: [] as { id: string, patch: Data }[] }

  const fieldOf = (id: string, f: string) => (f === '__name__' ? id : store.get(id)?.[f])

  function query(st: { wheres: [string, string, unknown][], orders: string[], after?: unknown[], limit?: number }): any {
    return {
      where: (f: string, op: string, v: unknown) => query({ ...st, wheres: [...st.wheres, [f, op, v]] }),
      orderBy: (f: string) => query({ ...st, orders: [...st.orders, f] }),
      startAfter: (...after: unknown[]) => query({ ...st, after }),
      select: () => query(st),
      limit: (n: number) => query({ ...st, limit: n }),
      get: async () => {
        log.broadcastQueries.push(st.wheres.map(w => `${w[0]}${w[1]}`).join('&'))
        const orders = [...st.orders]
        const ineq = st.wheres.find(w => w[1] !== '==')?.[0]
        if (ineq && !orders.includes(ineq)) orders.unshift(ineq)
        if (!orders.includes('__name__')) orders.push('__name__')
        let ids = [...store.keys()]
        for (const [f, op, v] of st.wheres) {
          ids = ids.filter((id) => {
            const c = cmp(keyOf(fieldOf(id, f)), keyOf(v))
            if (c == null) return false
            return op === '<=' ? c <= 0 : op === '>=' ? c >= 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : c === 0
          })
        }
        ids = ids.filter(id => orders.every(f => keyOf(fieldOf(id, f)) != null))
        const tuple = (id: string) => orders.map(f => keyOf(fieldOf(id, f)))
        const cmpTuple = (a: Key[], b: Key[]) => {
          for (let i = 0; i < Math.min(a.length, b.length); i++) {
            const c = cmp(a[i]!, b[i]!) ?? 0
            if (c) return c
          }
          return 0
        }
        ids.sort((a, b) => cmpTuple(tuple(a), tuple(b)))
        if (st.after) {
          const after = st.after.map(keyOf)
          ids = ids.filter(id => cmpTuple(tuple(id).slice(0, after.length), after) > 0)
        }
        if (st.limit != null) ids = ids.slice(0, st.limit)
        log.reads += Math.max(1, ids.length)
        return {
          size: ids.length,
          empty: ids.length === 0,
          docs: ids.map((id) => {
            const snapshot = { ...store.get(id)! }
            return {
              id,
              data: () => ({ ...snapshot }),
              get: (f: string) => snapshot[f],
              ref: {
                id,
                update: async (patch: Data) => {
                  log.updates.push({ id, patch })
                  const cur = store.get(id)!
                  for (const [k, v] of Object.entries(patch)) {
                    if (v === '__delete__') delete cur[k]
                    else cur[k] = v
                  }
                },
              },
            }
          }),
        }
      },
    }
  }

  const db = {
    collection: (name: string) => (name === 'cronState'
      ? {
          doc: (id: string) => ({
            get: async () => {
              log.reads++
              const d = cron.get(id)
              return { exists: !!d, data: () => (d ? { ...d } : undefined) }
            },
            set: async (data: Data, o?: { merge?: boolean }) => {
              cron.set(id, o?.merge ? { ...(cron.get(id) ?? {}), ...data } : data)
            },
          }),
        }
      : query({ wheres: [], orders: [] })),
  }
  return { db: db as never, store, cron, log }
}

/** 一則發完 `ageDays` 天的推播。`queued`＝發送那支已經寫上「下一次該問的時間」（上線後發的都是這樣） */
function row(id: string, ageDays: number, over: Data = {}, queued = true) {
  const completedAt = NOW - ageDays * DAY
  const data: Data = {
    workspaceId: 'ws',
    status: 'completed',
    sentCount: 100,
    startedAt: ts(completedAt - 60_000),
    completedAt: ts(completedAt),
    lineAggregationUnit: `u-${id}`,
    ...over,
  }
  const next = lineStatsNextDueAt(completedAt, data.lineStats)
  if (queued && next != null && data.lineStatsNextAt === undefined) data.lineStatsNextAt = next
  return { id, data }
}

const fetchMock = vi.mocked(fetchBroadcastLineInsight)

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ lineUniqueImpression: 40, lineUniqueClick: 21 })
})

describe('snapshotBroadcastLineStats：每一輪做的事', () => {
  it('問到的人數存進推播那一筆，輪次照發完幾天算，下一次該問的時間改成下一輪', async () => {
    const { db, store } = fakeDb([row('a', 3.5)])
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(store.get('a')!.lineStats).toEqual({ opened: 40, clicked: 21, round: 2, fetchedAt: NOW })
    // 第 2 輪問完 → 第 7 天再問第 3 輪
    expect(store.get('a')!.lineStatsNextAt).toBe(NOW - 3.5 * DAY + 7 * DAY)
    expect(r).toMatchObject({ due: 1, calls: 1, written: 1, failed: 0, deferred: 0 })
  })

  it('第 3 輪問完：「下一次」整欄拿掉，之後連讀都不會讀到它', async () => {
    const { db, store, log } = fakeDb([row('a', 8, { lineStats: { opened: 1, clicked: 1, round: 2, fetchedAt: 1 } })])
    await snapshotBroadcastLineStats(db, { now: NOW })
    expect(store.get('a')!.lineStats.round).toBe(3)
    expect('lineStatsNextAt' in store.get('a')!).toBe(false)
    const before = log.reads
    await snapshotBroadcastLineStats(db, { now: NOW + DAY })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 第二輪只剩標記那一份＋一個空查詢
    expect(log.reads - before).toBe(2)
  })

  it('⛔ 一輪最多問 LINE 6 次，排不到的要講還剩幾則（不靜靜丟掉）；到期最久的先做', async () => {
    // 故意讓最新的排在前面：順序要靠「下一次該問的時間」，不是靠放進去的順序
    const rows = Array.from({ length: 9 }, (_, i) => row(`b${i}`, 2 + i))
    const { db, log } = fakeDb(rows)
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(r).toMatchObject({ due: 9, calls: 6, written: 6, deferred: 3 })
    // 發完第 10 天那則最快就要查不到了（它的第 3 輪 3 天前就該問），排第一個
    expect(log.updates[0]!.id).toBe('b8')
    // 下一輪接著做剩下的 3 則
    fetchMock.mockClear()
    const r2 = await snapshotBroadcastLineStats(db, { now: NOW + 10 * 60_000 })
    expect(r2).toMatchObject({ due: 3, calls: 3, deferred: 0 })
  })

  it('發送時沒帶統計標記的：記一筆、拿掉「下一次」，⛔ 不花 LINE 的查詢次數', async () => {
    const { db, store } = fakeDb([row('x', 2, { lineInsightAggregationApplied: false })])
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.get('x')!.lineStats).toEqual({ opened: null, clicked: null, round: 3, fetchedAt: NOW, unavailable: true })
    expect('lineStatsNextAt' in store.get('x')!).toBe(false)
    expect(r.calls).toBe(0)
  })

  it('問失敗：留著上一輪的數字、⛔ 不推進輪次，記下原因，6 小時後再排', async () => {
    fetchMock.mockResolvedValue({ lineUniqueImpression: null, lineUniqueClick: null, lineInsightError: '429 too many' })
    const { db, store } = fakeDb([row('e', 3.5, { lineStats: { opened: 30, clicked: 10, round: 1, fetchedAt: 1 } })])
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(store.get('e')!.lineStats).toEqual({ opened: 30, clicked: 10, round: 1, fetchedAt: 1, errorAt: NOW, error: '429 too many' })
    expect(store.get('e')!.lineStatsNextAt).toBe(NOW + LINE_STATS_RETRY_MS)
    expect(r.failed).toBe(1)
  })

  it('排在隊伍裡、但已經沒事可做的（重設成草稿、沒送到人、超過 28 天）：拿掉「下一次」，不問 LINE', async () => {
    const { db, store } = fakeDb([
      row('draft', 3, { status: 'draft', lineStatsNextAt: NOW - DAY }),
      row('zero', 3, { sentCount: 0, lineStatsNextAt: NOW - DAY }),
      row('old', 40, { lineStats: { opened: 1, clicked: 1, round: 2, fetchedAt: 1 } }),
    ])
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(fetchMock).not.toHaveBeenCalled()
    for (const id of ['draft', 'zero', 'old']) expect('lineStatsNextAt' in store.get(id)!, id).toBe(false)
    expect(r.dropped).toBe(3)
  })

  it('時間還沒到卻被排進來（例：發送那支的時鐘比較快）：改成正確的時間，不問 LINE', async () => {
    const { db, store } = fakeDb([row('early', 0.5, { lineStatsNextAt: NOW - 60_000 })])
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.get('early')!.lineStatsNextAt).toBe(NOW - 0.5 * DAY + DAY)
    expect(r.rescheduled).toBe(1)
  })

  it('同一個時間點重跑：問過的不會再問（冪等）', async () => {
    const { db } = fakeDb([row('a', 3.5)])
    await snapshotBroadcastLineStats(db, { now: NOW })
    await snapshotBroadcastLineStats(db, { now: NOW })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('完成時間是 {_seconds} 的樣子也讀得懂（走全站共用的 parseFirestoreDate）', async () => {
    const completedAt = NOW - 3.5 * DAY
    const { db, store } = fakeDb([{
      id: 's',
      data: { workspaceId: 'ws', status: 'completed', sentCount: 100, completedAt: { _seconds: completedAt / 1000, _nanoseconds: 0 }, lineStatsNextAt: completedAt + DAY },
    }])
    await snapshotBroadcastLineStats(db, { now: NOW })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.get('s')!.lineStats.round).toBe(2)
  })
})

describe('snapshotBroadcastLineStats：讀取量與不漏掉最新的（2026-10-12 審查）', () => {
  it('⭐ 平常（沒有到期的）：28 天內 300 則都做完了，一輪只讀標記＋一個空查詢，不會把 300 則讀回來', async () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      row(`d${i}`, 8 + (i % 20), { lineStats: { opened: 1, clicked: 1, round: 3, fetchedAt: 1 } }))
    const { db, log } = fakeDb(rows)
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(log.reads).toBe(2)
    expect(r.scanned).toBe(0)
  })

  it('⭐ 28 天內超過 500 則：最新到期的那幾則照樣做得到（以前最舊的 500 則永遠占著名額）', async () => {
    const done = Array.from({ length: 590 }, (_, i) =>
      row(`old${String(i).padStart(3, '0')}`, 8 + (i % 19), { lineStats: { opened: 1, clicked: 1, round: 3, fetchedAt: 1 } }))
    const fresh = Array.from({ length: 10 }, (_, i) => row(`new${i}`, 1 + i / 100))
    const { db, store } = fakeDb([...done, ...fresh])
    await snapshotBroadcastLineStats(db, { now: NOW })
    await snapshotBroadcastLineStats(db, { now: NOW + 10 * 60_000 })
    for (let i = 0; i < 10; i++) expect(store.get(`new${i}`)!.lineStats?.round, `new${i}`).toBe(1)
  })
})

describe('snapshotBroadcastLineStats：上線前就發完的推播（沒有「下一次」那一欄）', () => {
  it('⭐ 第一輪就補上「下一次」並照樣問到；做完的、沒送到人的不補', async () => {
    const { db, store, cron } = fakeDb([
      row('l1', 3.5, {}, false),
      row('l2', 10, { lineStats: { opened: 5, clicked: 2, round: 1, fetchedAt: 1 } }, false),
      row('l3', 9, { lineStats: { opened: 5, clicked: 2, round: 3, fetchedAt: 1 } }, false),
      row('l4', 2, { sentCount: 0 }, false),
      row('l5', 40, {}, false),
    ], { legacy: null })
    const r = await snapshotBroadcastLineStats(db, { now: NOW })
    expect(r.legacy).toMatchObject({ stamped: 2, done: false })
    expect(store.get('l1')!.lineStats.round).toBe(2)
    expect(store.get('l2')!.lineStats.round).toBe(3)
    for (const id of ['l3', 'l4', 'l5']) expect(store.get(id)!.lineStatsNextAt, id).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(cron.get(LEGACY_DOC)).toMatchObject({ startedAt: NOW })
  })

  it('⭐ 補完而且過了 1 小時才算做完；做完之後每一輪只讀標記那一份，⛔ 不再掃推播', async () => {
    const { db, cron, log } = fakeDb([row('l1', 3.5, {}, false)], { legacy: null })
    await snapshotBroadcastLineStats(db, { now: NOW })
    await snapshotBroadcastLineStats(db, { now: NOW + 30 * 60_000 })
    expect(cron.get(LEGACY_DOC)!.doneAt).toBeUndefined()
    const r = await snapshotBroadcastLineStats(db, { now: NOW + 70 * 60_000 })
    expect(r.legacy.done).toBe(true)
    expect(cron.get(LEGACY_DOC)!.doneAt).toBe(NOW + 70 * 60_000)

    log.broadcastQueries.length = 0
    const readsBefore = log.reads
    const r2 = await snapshotBroadcastLineStats(db, { now: NOW + 80 * 60_000 })
    expect(r2.legacy).toMatchObject({ scanned: 0, done: true })
    // 只剩到期隊伍那一個查詢（空的）；補標記那一趟不再查
    expect(log.broadcastQueries).toEqual(['lineStatsNextAt<='])
    expect(log.reads - readsBefore).toBe(2)
  })

  it('一輪補不完就分好幾輪，從上次停的地方接著補（同一個完成時間的也不會漏）', async () => {
    const sameTime = { completedAt: ts(NOW - 3 * DAY), startedAt: ts(NOW - 3 * DAY) }
    const rows = [
      ...['a', 'b', 'c'].map(id => row(id, 3, sameTime, false)),
      row('d', 4, {}, false),
      row('e', 5, {}, false),
    ]
    const { db, store } = fakeDb(rows, { legacy: null })
    for (let i = 0; i < 4; i++) await snapshotBroadcastLineStats(db, { now: NOW + i * 60_000, legacyPageSize: 2 })
    for (const id of ['a', 'b', 'c', 'd', 'e']) expect(store.get(id)!.lineStats?.round, id).toBeGreaterThanOrEqual(1)
  })
})
