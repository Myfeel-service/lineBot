import { describe, expect, it } from 'vitest'
import {
  buildDaysFromSessions,
  contiguousDayRuns,
  emptyDayStats,
  foldSessionIntoDay,
  liveBuildDays,
  mergeDays,
  taipeiDayKeysBetween,
} from './conversation-stats-rollup'

/**
 * 日結的算式本體（`E-29`）。端點測試已經釘住「日結與現場算一致」，
 * 這裡補的是算式自己的邊界：日界線、樣本上限、以及「查不到不可以變成 0」。
 */

const ts = (iso: string) => ({ toMillis: () => new Date(iso).getTime(), toDate: () => new Date(iso) })

const session = (over: Record<string, any> = {}) => ({
  userId: 'U1',
  openedAt: ts('2026-08-20T02:00:00Z'),
  origin: 'message',
  hasInbound: true,
  initialHandler: 'ai',
  hasHandoff: false,
  status: 'open',
  ...over,
})

describe('日界線（台北）', () => {
  it('區間展開含頭尾，而且照台北日界線切', () => {
    const keys = taipeiDayKeysBetween(
      new Date('2026-08-18T16:00:00Z'), // 台北 8/19 00:00
      new Date('2026-08-21T15:59:59Z'), // 台北 8/21 23:59
    )
    expect(keys).toEqual(['2026-08-19', '2026-08-20', '2026-08-21'])
  })

  it('台北凌晨開的場算「那一天」，不會被算成前一天（UTC 伺服器上最容易錯的地方）', () => {
    // 台北 8/21 00:30 = UTC 8/20 16:30
    const days = buildDaysFromSessions([session({ openedAt: ts('2026-08-20T16:30:00Z') })] as any)
    expect([...days.keys()]).toEqual(['2026-08-21'])
  })
})

describe('一天的算式', () => {
  it('四種首接、轉真人、結案、交叉都各記一次', () => {
    const day = emptyDayStats('2026-08-20')
    foldSessionIntoDay(day, session({ initialHandler: 'bot', hasHandoff: true, status: 'closed' }))
    foldSessionIntoDay(day, session({ initialHandler: 'ai', hasHandoff: true, status: 'closed' }))
    foldSessionIntoDay(day, session({ initialHandler: 'human' }))
    foldSessionIntoDay(day, session({ initialHandler: 'unhandled', status: 'closed' }))

    expect(day.total).toBe(4)
    expect(day.bot).toBe(1)
    expect(day.ai).toBe(1)
    expect(day.human).toBe(1)
    expect(day.unhandled).toBe(1)
    expect(day.handoff).toBe(2)
    expect(day.closed).toBe(3)
    expect(day.botEscalated).toBe(1)
    expect(day.aiEscalated).toBe(1)
    // ⛔ 已結束**且有人首接過**才算：未首接的結案不能進分子，否則結案率會超過 100%
    expect(day.closedHandled).toBe(2)
  })

  it('加好友出生、客人還沒開口的場整場不進統計', () => {
    const days = buildDaysFromSessions([
      session({ origin: 'follow', hasInbound: false }),
      session({ origin: 'follow', hasInbound: true }), // 開口了 → 算
    ] as any)
    expect(days.get('2026-08-20')!.total).toBe(1)
  })

  it('「沒人回」的樣本只留最早 3 筆（區間再大也不會長大）', () => {
    const day = emptyDayStats('2026-08-20')
    for (let i = 5; i >= 1; i--) {
      foldSessionIntoDay(day, session({
        initialHandler: 'unhandled',
        userId: `U${i}`,
        openedAt: ts(`2026-08-20T0${i}:00:00Z`),
      }))
    }
    expect(day.unhandled).toBe(5)
    expect(day.unhandledSamples.map(s => s.userId)).toEqual(['U1', 'U2', 'U3'])
  })

  it('轉真人只存原料，不預先判斷等太久（門檻由讀取端套）', () => {
    const day = emptyDayStats('2026-08-20')
    foldSessionIntoDay(day, session({
      hasHandoff: true,
      handoffRequestedAt: ts('2026-08-20T02:05:00Z'),
      humanFirstRepliedAt: null,
    }))
    expect(day.handoffWaits).toHaveLength(1)
    expect(day.handoffWaits[0]!.repliedAtMs).toBeNull() // 還沒有人回＝等待時間隨時間長大
    // 沒有任何「已經超過門檻」的欄位——那是讀取端的事
    expect(Object.keys(day)).not.toContain('handoffWaitExceeded')
  })

  it('沒帶 handoffRequestedAt 的轉真人不進原料（算不出等多久）', () => {
    const day = emptyDayStats('2026-08-20')
    foldSessionIntoDay(day, session({ hasHandoff: true }))
    expect(day.handoff).toBe(1)
    expect(day.handoffWaits).toHaveLength(0)
  })
})

describe('把幾天加起來', () => {
  it('計數相加、樣本重新取最早 3 筆', () => {
    const a = emptyDayStats('2026-08-19')
    a.total = 2; a.ai = 2; a.newFriends = 3
    a.unhandledSamples = [{ userId: 'A1', openedAtMs: 200 }]
    const b = emptyDayStats('2026-08-20')
    b.total = 1; b.bot = 1; b.newFriends = 4
    b.unhandledSamples = [{ userId: 'B1', openedAtMs: 100 }, { userId: 'B2', openedAtMs: 300 }]

    const m = mergeDays('range', [a, b])
    expect(m.total).toBe(3)
    expect(m.ai).toBe(2)
    expect(m.bot).toBe(1)
    expect(m.newFriends).toBe(7)
    expect(m.unhandledSamples.map(s => s.userId)).toEqual(['B1', 'A1', 'B2'])
  })

  it('⛔ 只要有一天的新朋友是「查不到」，整段就是查不到（不可以變成 0）', () => {
    const a = emptyDayStats('2026-08-19'); a.newFriends = 5
    const b = emptyDayStats('2026-08-20'); b.newFriends = null

    expect(mergeDays('range', [a, b]).newFriends).toBeNull()
    // 全部都查得到才給數字
    b.newFriends = 0
    expect(mergeDays('range', [a, b]).newFriends).toBe(5)
  })
})

describe('不連續的日子分段查（`E-38`：日結排程把中間 80 幾天整段讀進來）', () => {
  it('切成連續的幾段：跨月、去重、亂序都照台北日曆接', () => {
    expect(contiguousDayRuns(['2026-10-16', '2026-07-20', '2026-10-14', '2026-10-15', '2026-10-15']))
      .toEqual([['2026-07-20'], ['2026-10-14', '2026-10-15', '2026-10-16']])
    expect(contiguousDayRuns(['2026-08-31', '2026-09-01'])).toEqual([['2026-08-31', '2026-09-01']])
    expect(contiguousDayRuns([])).toEqual([])
  })

  /** 假資料庫：記下每一支範圍查詢的起訖，回傳落在範圍內的文件 */
  function fakeDb(rows: { sessions: Record<string, any>[], users: { createdAt: string }[] }) {
    const ranges: Array<{ col: string, from: string, to: string }> = []
    const db = {
      collection(col: string) {
        const conds: Record<string, Date> = {}
        const q: any = {
          where(field: string, op: string, v: any) {
            if (op === '>=') conds.from = v
            if (op === '<=') conds.to = v
            return q
          },
          select() { return q },
          async get() {
            ranges.push({ col, from: conds.from!.toISOString(), to: conds.to!.toISOString() })
            const inRange = (ms: number) => ms >= conds.from!.getTime() && ms <= conds.to!.getTime()
            const docs = col === 'users'
              ? rows.users.filter(u => inRange(Date.parse(u.createdAt))).map(u => ({ data: () => ({ createdAt: ts(u.createdAt) }) }))
              : rows.sessions.filter(s => inRange(s.openedAt.toMillis())).map(s => ({ data: () => s }))
            return { docs }
          },
        }
        return q
      },
    }
    return { db: db as any, ranges }
  }

  it('「最近 3 天＋一天舊日子」查兩段，不可以把中間那段讀進來；算出來的數字不變', async () => {
    const { db, ranges } = fakeDb({
      sessions: [
        session({ openedAt: ts('2026-07-20T03:00:00Z') }),
        session({ openedAt: ts('2026-08-20T03:00:00Z') }), // 中間那段：不該被讀到
        session({ openedAt: ts('2026-10-15T03:00:00Z') }),
      ],
      users: [{ createdAt: '2026-07-20T05:00:00Z' }, { createdAt: '2026-09-01T05:00:00Z' }, { createdAt: '2026-10-16T05:00:00Z' }],
    })
    const days = await liveBuildDays(db, 'w1', ['2026-10-14', '2026-10-15', '2026-10-16', '2026-07-20'], { withFriends: true })

    // 對話與新好友各兩段：7/20 一段、10/14～10/16 一段（台北日界＝前一天 16:00Z）
    expect(ranges.filter(r => r.col === 'conversationSessions').map(r => [r.from.slice(0, 10), r.to.slice(0, 10)]))
      .toEqual([['2026-07-19', '2026-07-20'], ['2026-10-13', '2026-10-16']])
    expect(ranges.filter(r => r.col === 'users')).toHaveLength(2)
    // 數字跟一支大查詢算的一樣：只有要的那幾天有格子，中間那場與那位新好友沒被算進任何一天
    expect([...days.keys()].sort()).toEqual(['2026-07-20', '2026-10-14', '2026-10-15', '2026-10-16'])
    expect(days.get('2026-07-20')!.total).toBe(1)
    expect(days.get('2026-10-15')!.total).toBe(1)
    expect(days.get('2026-10-14')!.total).toBe(0)
    expect(days.get('2026-07-20')!.newFriends).toBe(1)
    expect(days.get('2026-10-16')!.newFriends).toBe(1)
    expect(days.get('2026-10-14')!.newFriends).toBe(0)
  })
})
