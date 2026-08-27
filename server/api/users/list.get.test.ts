import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 好友清單的快路徑（`E-26`）。
 *
 * 沒有搜尋、沒有標籤篩選＝好友頁直接開的那種請求，最常見也最不需要掃描：
 * 原本一律從第 1 筆開始、一批 120 筆撈回整份文件再在記憶體篩，為了 20 筆讀 120 筆。
 *
 * 釘住的四件事：
 * ① 只查一次、有投影、要的筆數就是一頁的筆數（不再為 20 筆抓 120 筆）
 * ② **封鎖的客人在查詢層就排掉**——這不只是效率問題：在記憶體篩會讓「頁面的第幾筆」
 *    跟「資料庫的第幾筆」對不上，補滿一頁時借到下一頁的第一筆＝翻頁時同一個人出現兩次
 *    （2026-08-27 拿正式資料驗才抓到，改法就是這條）
 * ③ 總數與清單同一個口徑（否則分頁器會多出點進去空空的頁）
 * ④ 索引還沒建好時要**自動退回掃描路徑**，不能讓好友頁整頁壞掉
 * 有搜尋／篩選時一律照舊走掃描路徑（那條有掃描上限與 truncated 語意，不能被順手改掉）。
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

const { default: handler } = await import('./list.get')
const { getDb } = await import('~~/server/utils/firebase')

/** 30 位好友，第 3、7 位被封鎖 */
const USERS = Array.from({ length: 30 }, (_, i) => ({
  id: `${WS}_U${String(i).padStart(3, '0')}`,
  workspaceId: WS,
  lineUserId: `U${String(i).padStart(3, '0')}`,
  displayName: `客人 ${i}`,
  pictureUrl: '',
  createdAt: { toMillis: () => 1_000_000 - i },
  isBlocked: i === 3 || i === 7,
  // 清單不看的肥欄位
  note: '一大段客服備註'.repeat(30),
}))

/**
 * 假 Firestore。三件事跟正式行為對齊，測試才有意義：
 * ①`where('isBlocked','==',false)` 真的會篩 ②`select()` 真的會裁欄位
 * ③`indexMissing` 時查詢會丟 FAILED_PRECONDITION（模擬索引還沒建好）
 */
function fakeDb(opts: { indexMissing?: boolean } = {}) {
  const calls: { col: string, selected: string[], offset: number, limit: number, filtered: boolean }[] = []

  const collection = (col: string) => {
    const state = { selected: [] as string[], offset: 0, limit: 0, unblockedOnly: false, blockedOnly: false }
    const rowsFor = () => {
      let rows = USERS
      if (state.unblockedOnly) rows = rows.filter(u => !u.isBlocked)
      if (state.blockedOnly) rows = rows.filter(u => u.isBlocked)
      return rows
    }
    const failIfIndexMissing = () => {
      if (opts.indexMissing && state.unblockedOnly) {
        const e: any = new Error('The query requires an index. FAILED_PRECONDITION')
        e.code = 9
        throw e
      }
    }
    const q: any = {
      where: (field: string, _op: string, value: unknown) => {
        if (field === 'isBlocked' && value === false) state.unblockedOnly = true
        if (field === 'isBlocked' && value === true) state.blockedOnly = true
        return q
      },
      orderBy: () => q,
      select: (...f: string[]) => { state.selected = f; return q },
      offset: (n: number) => { state.offset = n; return q },
      limit: (n: number) => { state.limit = n; return q },
      count: () => ({
        get: async () => {
          failIfIndexMissing()
          return { data: () => ({ count: rowsFor().length }) }
        },
      }),
      get: async () => {
        if (col === 'userTagSuggestions' || col === 'userTags' || col === 'tags')
          return { docs: [], empty: true, size: 0 }
        failIfIndexMissing()
        calls.push({ col, selected: state.selected, offset: state.offset, limit: state.limit, filtered: state.unblockedOnly })
        const rows = rowsFor().slice(state.offset, state.offset + (state.limit || USERS.length))
        return {
          empty: rows.length === 0,
          size: rows.length,
          docs: rows.map(r => ({
            id: r.id,
            data: () => {
              if (!state.selected.length) return r
              const out: Record<string, unknown> = {}
              for (const f of state.selected) if (f in r) out[f] = (r as Record<string, unknown>)[f]
              return out
            },
          })),
        }
      },
      doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
    }
    return q
  }
  return { db: { collection, getAll: async () => [] } as any, calls }
}

describe('好友清單快路徑（E-26）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('沒有搜尋／篩選：只查一次 users、有投影、要幾筆就查幾筆', async () => {
    const { db, calls } = fakeDb()
    vi.mocked(getDb).mockReturnValue(db)
    currentQuery = { page: '1', limit: '20' }

    const res = await (handler as any)({} as never)

    const userQueries = calls.filter(c => c.col === 'users')
    expect(userQueries).toHaveLength(1) // 這一行紅掉＝又回到一批 120 筆的掃描
    expect(userQueries[0]!.selected).toContain('displayName')
    expect(userQueries[0]!.selected).not.toContain('note') // 備註留在資料庫就好
    expect(userQueries[0]!.limit).toBe(20) // 不再為 20 筆抓 120 筆
    expect(res.users).toHaveLength(20)
  })

  it('封鎖的客人在查詢層就排掉（⛔不是撈回來再篩，否則翻頁會重複）', async () => {
    const { db, calls } = fakeDb()
    vi.mocked(getDb).mockReturnValue(db)
    currentQuery = { page: '1', limit: '20' }

    const res = await (handler as any)({} as never)

    // 這一行紅掉＝又變成「先撈回來再於記憶體篩」，翻頁會借到下一頁的第一筆
    expect(calls.find(c => c.col === 'users')!.filtered).toBe(true)
    const ids = res.users.map((u: any) => u.id)
    expect(ids).not.toContain(`${WS}_U003`)
    expect(ids).not.toContain(`${WS}_U007`)
    expect(ids[0]).toBe(`${WS}_U000`) // 順序照加入時間新→舊
  })

  it('第 2 頁接得剛好：不重複也不跳過（封鎖的那兩位已在查詢層排掉）', async () => {
    const unblocked = USERS.filter(u => !u.isBlocked).map(u => u.id)

    const page = async (n: number, limit: number) => {
      const { db } = fakeDb()
      vi.mocked(getDb).mockReturnValue(db)
      currentQuery = { page: String(n), limit: String(limit) }
      const res = await (handler as any)({} as never)
      return res.users.map((u: any) => u.id)
    }

    const p1 = await page(1, 10)
    const p2 = await page(2, 10)
    expect(p1).toEqual(unblocked.slice(0, 10))
    expect(p2).toEqual(unblocked.slice(10, 20))
    expect(p1.filter((id: string) => p2.includes(id))).toEqual([]) // 沒有人同時出現在兩頁
  })

  it('總數與清單同口徑（28 位，不含封鎖的兩位）', async () => {
    const { db } = fakeDb()
    vi.mocked(getDb).mockReturnValue(db)
    currentQuery = { page: '1', limit: '20' }

    const res = await (handler as any)({} as never)
    expect(res.total).toBe(28)
  })

  it('索引還沒建好 → 自動退回掃描路徑，好友頁照樣看得到人', async () => {
    // ⚠️ 用**新載入的一份**模組跑：那支端點撞到「索引還沒好」會記在模組層變數上
    //    （避免每次請求都白撞一次失敗查詢），沿用同一份的話會污染其他測試。
    vi.resetModules()
    const { default: freshHandler } = await import('./list.get')
    const { db, calls } = fakeDb({ indexMissing: true })
    vi.mocked(getDb).mockReturnValue(db)
    currentQuery = { page: '1', limit: '20' }

    const res = await (freshHandler as any)({} as never)

    // 快路徑掛了但畫面沒壞：走掃描路徑（批次 120、不投影）
    const userQueries = calls.filter(c => c.col === 'users')
    expect(userQueries[0]!.limit).toBe(120)
    expect(res.users).toHaveLength(20)
    expect(res.users.map((u: any) => u.id)).not.toContain(`${WS}_U003`) // 掃描路徑也會篩封鎖
  })

  it('有搜尋時照舊走掃描路徑（掃描上限與 truncated 語意不能被順手改掉）', async () => {
    const { db, calls } = fakeDb()
    vi.mocked(getDb).mockReturnValue(db)
    currentQuery = { page: '1', limit: '20', search: '客人 1' }

    const res = await (handler as any)({} as never)

    const userQueries = calls.filter(c => c.col === 'users')
    expect(userQueries[0]!.limit).toBe(120)
    expect(userQueries[0]!.selected).toHaveLength(0)
    expect(res.truncated).toBe(false)
    expect(res.users.length).toBeGreaterThan(0)
  })
})
