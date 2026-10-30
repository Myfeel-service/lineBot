import { describe, expect, it, vi } from 'vitest'

/**
 * 受眾解析一定要帶帳號（`G-104`①，2026-09-29 權限盤點）。
 * 每一段查詢都是 `if (workspaceId)` 才加帳號過濾：空字串進來＝**全站**名單，
 * `/api/audience/estimate` 曾因超管沒帶帳號回全站人數。
 */

const { reads, fx } = vi.hoisted(() => ({
  reads: [] as { col: string, filters: [string, unknown][] }[],
  fx: {
    /** userTags 查回來的人 */
    tagUserIds: [] as string[],
    users: {} as Record<string, Record<string, unknown>>,
    /** 每次 getAll 拿幾筆、帶了什麼選項 */
    getAllCalls: [] as { n: number, opts: unknown }[],
    inFlight: 0,
    maxInFlight: 0,
  },
}))

vi.mock('./firebase', () => {
  const query = (col: string, filters: [string, unknown][] = []): any => ({
    where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]]),
    doc: (id: string) => ({ id, col }),
    get: async () => {
      reads.push({ col, filters })
      if (col === 'userTags') return { docs: fx.tagUserIds.map((userId) => ({ data: () => ({ userId }) })) }
      return { docs: [] }
    },
  })
  return {
    getDb: () => ({
      collection: (col: string) => query(col),
      getAll: async (...args: any[]) => {
        const refs = args.filter((a) => typeof a?.id === 'string')
        fx.getAllCalls.push({ n: refs.length, opts: args.at(-1) })
        fx.inFlight++
        fx.maxInFlight = Math.max(fx.maxInFlight, fx.inFlight)
        await new Promise((r) => setTimeout(r, 5))
        fx.inFlight--
        return refs.map((r: { id: string }) => {
          const u = fx.users[r.id]
          return { id: r.id, exists: !!u, data: () => u }
        })
      },
    }),
  }
})

const { resolveAudienceUserIds, estimateAudienceCount } = await import('./audience')

const ALL = { conditions: [], joinedAfter: null, joinedBefore: null, isBlocked: null } as never

describe('resolveAudienceUserIds', () => {
  it('🔴 沒帶帳號 → 直接擋，⛔ 一筆都不讀（不會變成讀全站好友）', async () => {
    reads.length = 0
    await expect(resolveAudienceUserIds(ALL, '')).rejects.toThrow(/workspaceId/)
    await expect(estimateAudienceCount(ALL, '  ')).rejects.toThrow(/workspaceId/)
    expect(reads).toHaveLength(0)
  })

  it('帶了帳號 → 查詢一定加上帳號過濾', async () => {
    reads.length = 0
    await resolveAudienceUserIds(ALL, 'w1')
    expect(reads).toEqual([{ col: 'users', filters: [['workspaceId', 'w1']] }])
  })

  /**
   * `C-431`：2026-10-29 MYFEEL 標籤上 2,229 人，以前每 30 人一批、一批等完才查下一批（75 次、約 47 秒），
   * 推播頁「驗證並排程」被主機 30 秒切斷、排不上。
   */
  it('🔴 標籤上 2,229 人：幾批同時拿、每位只讀一筆；封鎖的、好友資料已經沒有的不算', async () => {
    const N = 2229
    fx.tagUserIds = Array.from({ length: N }, (_, i) => `u${i}`)
    fx.users = {}
    for (let i = 0; i < N; i++) {
      if (i === 7) continue // 標籤還在、好友資料已經沒有
      fx.users[`u${i}`] = { isBlocked: i % 10 === 0 }
    }
    fx.getAllCalls = []
    fx.maxInFlight = 0

    const ids = await resolveAudienceUserIds({
      conditions: [{ type: 'includeAny', tagIds: ['t1'] }],
      joinedAfter: null,
      joinedBefore: null,
      isBlocked: false,
    } as never, 'w1')

    const blocked = Math.ceil(N / 10)
    expect(ids).toHaveLength(N - blocked - 1)
    expect(ids).not.toContain('u0')
    expect(ids).not.toContain('u7')
    expect(ids).toContain('u1')
    // 讀的筆數跟以前一樣：每位好友一筆，沒有多讀
    expect(fx.getAllCalls.reduce((s, c) => s + c.n, 0)).toBe(N)
    expect(fx.getAllCalls.every((c) => c.n <= 300)).toBe(true)
    // ⛔ 不是一批等完才查下一批
    expect(fx.maxInFlight).toBeGreaterThan(1)
    // 只拿要用的兩格
    expect(fx.getAllCalls[0]!.opts).toEqual({ fieldMask: ['isBlocked', 'createdAt'] })
  })
})
