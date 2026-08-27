import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TREND_SESSION_FIELDS } from '~~/server/utils/conversation-stats-fields'

/**
 * 趨勢圖的欄位投影測試（`E-22`）。理由同 `kpi.get.test.ts`：
 * 假 Firestore 會照 `.select()` 真的裁掉欄位，投影漏了就會讓某一條線整批歸零。
 */

const WS = 'ws1'

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

const ts = (iso: string) => ({ toMillis: () => new Date(iso).getTime(), toDate: () => new Date(iso) })

// 台北時間 8/20 兩場、8/21 一場（其中一場是加好友沒開口，不進統計）
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
    openedAt: ts('2026-08-19T21:00:00Z'), // 同一天
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
]

function fakeDb() {
  const selected: string[] = []
  const collection = (name: string) => {
    const q: any = {
      where: () => q,
      orderBy: () => q,
      select: (...f: string[]) => {
        if (name === 'conversationSessions') selected.push(...f)
        return q
      },
      count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
      get: async () => {
        if (name === 'users') return { docs: [] } // 新朋友：這條測試不看
        return {
          docs: SESSIONS.map(row => ({
            id: row.userId,
            data: () => {
              if (!selected.length) return row
              const out: Record<string, unknown> = {}
              for (const f of selected) if (f in row) out[f] = (row as Record<string, unknown>)[f]
              return out
            },
          })),
        }
      },
    }
    return q
  }
  return { db: { collection } as any, selected }
}

describe('趨勢圖欄位投影（E-22）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('投影過的資料分桶與分類都要對（漏欄位就會有一條線整批歸零）', async () => {
    const { db } = fakeDb()
    vi.mocked(getDb).mockReturnValue(db)
    currentQuery = { startDate: '2026-08-01', endDate: '2026-08-31', granularity: 'day' }

    const { buckets } = await (handler as any)({} as never)

    // 只有 8/20 那天有兩場（8/21 那場是加好友沒開口，整場不進統計，連桶都不該生）
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.date).toBe('2026-08-20')
    expect(buckets[0]!.total).toBe(2)
    expect(buckets[0]!.ai).toBe(1) // 讀 initialHandler
    expect(buckets[0]!.bot).toBe(1)
    expect(buckets[0]!.handoff).toBe(1) // 讀 hasHandoff
    expect(buckets[0]!.closed).toBe(1) // 讀 status
    expect(buckets[0]!.aiEscalated).toBe(1) // 交叉
  })

  it('投影清單釘死＋不搬肥欄位', async () => {
    const { db, selected } = fakeDb()
    vi.mocked(getDb).mockReturnValue(db)
    currentQuery = { startDate: '2026-08-01', endDate: '2026-08-31', granularity: 'day' }
    await (handler as any)({} as never)

    expect(TREND_SESSION_FIELDS.sort()).toEqual(
      ['hasHandoff', 'hasInbound', 'initialHandler', 'openedAt', 'origin', 'status'].sort(),
    )
    expect(selected).not.toContain('closingPreview')
  })
})
