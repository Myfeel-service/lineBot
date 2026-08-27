import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TREND_SESSION_FIELDS } from '~~/server/utils/conversation-stats-fields'

/**
 * 趨勢圖：欄位投影（`E-22`）＋日結（`E-29`）。
 * 釘的兩件事同 `kpi.get.test.ts`：投影漏欄位會讓某一條線整批歸零；
 * 走日結與走現場算必須畫出一模一樣的桶。
 */

const WS = 'ws1'
const TODAY = '2026-08-31'
const NOW = new Date('2026-08-31T05:00:00Z') // 台北 13:00

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS, role: 'owner' })),
}))

let currentQuery: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => currentQuery)
vi.stubGlobal('createError', (o: { statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'e'), o))

const { default: handler } = await import('./trend.get')
const { getDb } = await import('~~/server/utils/firebase')
const rollup = await import('~~/server/utils/conversation-stats-rollup')

const ts = (iso: string) => ({ toMillis: () => new Date(iso).getTime(), toDate: () => new Date(iso) })

// 台北 8/20 兩場、8/21 一場（加好友沒開口，不進統計）、今天一場
const SESSIONS = [
  {
    userId: 'U1',
    openedAt: ts('2026-08-19T20:00:00Z'), // 台北 8/20 04:00
    origin: 'message',
    hasInbound: true,
    initialHandler: 'ai',
    hasHandoff: true,
    status: 'closed',
    closingPreview: '肥欄位'.repeat(80),
  },
  {
    userId: 'U2',
    openedAt: ts('2026-08-19T21:00:00Z'),
    origin: 'message',
    hasInbound: true,
    initialHandler: 'bot',
    hasHandoff: false,
    status: 'bot_handling',
  },
  {
    userId: 'U3',
    openedAt: ts('2026-08-20T21:00:00Z'), // 台北 8/21
    origin: 'follow',
    hasInbound: false, // 加好友沒開口 → 不算
    initialHandler: 'unhandled',
    hasHandoff: false,
    status: 'open',
  },
  {
    userId: 'U4',
    openedAt: ts('2026-08-31T02:00:00Z'), // 今天
    origin: 'message',
    hasInbound: true,
    initialHandler: 'human',
    hasHandoff: false,
    status: 'human_handling',
  },
]

function fakeDb(opts: { rollups?: Record<string, any>, friends?: string[] } = {}) {
  const selected: string[] = []
  const sessionQueries: { from: number, to: number }[] = []

  const collection = (name: string) => {
    const state = { from: -Infinity, to: Infinity, selected: [] as string[] }
    const q: any = {
      where: (field: string, op: string, value: any) => {
        if (field === 'openedAt' || field === 'createdAt') {
          const ms = value instanceof Date ? value.getTime() : value?.toMillis?.() ?? 0
          if (op === '>=') state.from = ms
          if (op === '<=') state.to = ms
        }
        return q
      },
      orderBy: () => q,
      select: (...f: string[]) => {
        state.selected = f
        if (name === 'conversationSessions') selected.push(...f)
        return q
      },
      count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
      get: async () => {
        if (name === 'users') {
          const rows = (opts.friends ?? []).map(iso => ({ createdAt: ts(iso) }))
            .filter(r => r.createdAt.toMillis() >= state.from && r.createdAt.toMillis() <= state.to)
          return { docs: rows.map(r => ({ data: () => r })) }
        }
        sessionQueries.push({ from: state.from, to: state.to })
        const rows = SESSIONS.filter(r => r.openedAt.toMillis() >= state.from && r.openedAt.toMillis() <= state.to)
        return {
          docs: rows.map(row => ({
            id: row.userId,
            data: () => {
              if (!state.selected.length) return row
              const out: Record<string, unknown> = {}
              for (const f of state.selected) if (f in row) out[f] = (row as Record<string, unknown>)[f]
              return out
            },
          })),
        }
      },
      doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
    }
    return q
  }

  const db: any = { getAll: async (...refs: any[]) => refs.map(r => r.__doc) }
  db.collection = (name: string) => {
    if (name !== rollup.STATS_DAILY_COLLECTION) return collection(name)
    return {
      doc: (id: string) => {
        const data = opts.rollups?.[id]
        return { __doc: { exists: !!data, data: () => data } }
      },
    }
  }
  return { db, selected, sessionQueries }
}

/** 每一天都寫一筆（含 0 場的日子）＝正式排程的行為 */
function rollupsFromSessions(friendsPerDay: Record<string, number> = {}) {
  const days = rollup.buildDaysFromSessions(SESSIONS as any)
  const out: Record<string, any> = {}
  for (const date of rollup.taipeiDayKeysBetween(
    new Date('2026-08-19T00:00:00+08:00'),
    new Date('2026-08-30T00:00:00+08:00'),
  )) {
    if (date === TODAY) continue
    const day = days.get(date) ?? rollup.emptyDayStats(date)
    out[`${WS}_${date}`] = {
      ...day,
      newFriends: friendsPerDay[date] ?? 0,
      workspaceId: WS,
      version: rollup.ROLLUP_VERSION,
      builtAt: Date.now(),
      waitsTruncated: false,
    }
  }
  return out
}

async function runTrend(db: any, q: Record<string, unknown> = {}) {
  vi.mocked(getDb).mockReturnValue(db)
  currentQuery = { startDate: '2026-08-19', endDate: '2026-08-31', granularity: 'day', ...q }
  return await (handler as any)({} as never)
}

describe('趨勢圖：日結與現場算必須一致（E-29）', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ now: NOW, toFake: ['Date'] }) })

  it('沒有日結（全部現場算）：分桶與分類都對', async () => {
    const { buckets } = await runTrend(fakeDb().db)

    // 8/20 兩場 + 今天一場；8/21 那場是加好友沒開口，整場不進統計、連桶都不生
    expect(buckets.map((b: any) => b.date)).toEqual(['2026-08-20', '2026-08-31'])
    const d20 = buckets[0]!
    expect(d20.total).toBe(2)
    expect(d20.ai).toBe(1)
    expect(d20.bot).toBe(1)
    expect(d20.handoff).toBe(1)
    expect(d20.closed).toBe(1)
    expect(d20.aiEscalated).toBe(1)
    expect(buckets[1]!.human).toBe(1) // 今天那場
  })

  it('有日結：畫出來的桶與現場算**逐格相同**', async () => {
    const live = await runTrend(fakeDb().db)
    const withRollup = await runTrend(fakeDb({ rollups: rollupsFromSessions() }).db)
    expect(withRollup).toEqual(live)
  })

  it('有日結時只查「今天」那一段對話', async () => {
    const f = fakeDb({ rollups: rollupsFromSessions() })
    await runTrend(f.db)
    expect(f.sessionQueries).toHaveLength(1)
    expect(f.sessionQueries[0]!.from).toBe(new Date('2026-08-30T16:00:00Z').getTime()) // 台北 8/31 00:00
  })

  it('月分桶：把那些天加起來（granularity=month）', async () => {
    const { buckets } = await runTrend(fakeDb({ rollups: rollupsFromSessions() }).db, { granularity: 'month' })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.date).toBe('2026-08')
    expect(buckets[0]!.total).toBe(3) // 8/20 兩場 + 今天一場
  })

  it('只有新朋友、沒有對話的日子也要有桶（活動日常見）', async () => {
    const { buckets } = await runTrend(fakeDb({ rollups: rollupsFromSessions({ '2026-08-25': 5 }) }).db)
    const d25 = buckets.find((b: any) => b.date === '2026-08-25')
    expect(d25).toBeTruthy()
    expect(d25!.total).toBe(0)
    expect(d25!.newFriends).toBe(5)
  })

  it('新朋友查不到 → 整批省略那個欄位（圖上缺線比畫假的 0 線誠實）', async () => {
    const rollups = rollupsFromSessions()
    for (const k of Object.keys(rollups)) rollups[k]!.newFriends = null
    const { buckets } = await runTrend(fakeDb({ rollups }).db)
    expect(buckets.length).toBeGreaterThan(0)
    for (const b of buckets) expect(b.newFriends).toBeUndefined()
  })

  it('投影清單釘死＋不搬肥欄位', async () => {
    const f = fakeDb()
    await runTrend(f.db)
    expect([...TREND_SESSION_FIELDS].sort()).toEqual(
      ['hasHandoff', 'hasInbound', 'initialHandler', 'openedAt', 'origin', 'status'].sort(),
    )
    expect(f.selected).not.toContain('closingPreview')
  })
})
