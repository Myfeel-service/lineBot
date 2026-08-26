import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 好友列表回傳的「還有幾位客人的 AI 建議等人決定」（`pendingSuggestionTotal`）。
 *
 * 這個數字餵的是列表頂端那條待辦。先前建議的唯一入口是每一列名字後面那顆橘章，
 * 它只說得出「這一列有」，說不出「這一頁有」——4 位建議散在 93 頁裡，
 * 除非剛好翻到那一列，否則不知道有事情等你決定。
 *
 * 這裡釘住兩條會被改壞、而且壞了不會有人發現的契約：
 *
 * 1. **這個數字不吃畫面上的篩選。** 勾了「只看有 AI 建議的」再加上標籤篩選之後，
 *    交集可能只剩 1 位，但待辦仍然要說 4——它回答的是「還有幾件事等你決定」，
 *    跟著篩選變小會讓人以為已經處理掉了。
 * 2. **篩到空結果時也要帶著這個數字。** 那正是「我是不是漏了什麼」的時候，
 *    待辦條在那時最該在（提早 return 很容易把它漏掉）。
 */

const WS = 'ws-pending'
const uid = (n: number) => `U${String(n).padStart(31, '0')}`
const docId = (n: number) => `${WS}_${uid(n)}`

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS })),
}))

let currentQuery: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => currentQuery)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./list.get')
const { getDb } = await import('~~/server/utils/firebase')

/**
 * 只做這條路徑會用到的鏈。`userTagSuggestions` 兩種讀法都要支援：
 * `.get()`（只看建議時撈整份名單）與 `.count().get()`（其餘情況只問總數）。
 */
function fakeDb(opts: {
  /** 有待處理建議的客人（users 集合的 doc id） */
  suggestedDocIds: string[]
  /** users 集合裡的人 */
  users: { id: string, displayName: string }[]
  /** userTags：哪個人有哪個標籤 */
  userTags?: { userId: string, tagId: string }[]
}) {
  const suggestions = opts.suggestedDocIds
  const collection = (name: string) => {
    const q: any = {
      where: () => q,
      orderBy: () => q,
      select: () => q,
      limit: () => q,
      offset: () => q,
      startAfter: () => q,
      // ⛔ 要記住是哪個集合的 ref：db.getAll 同時被「讀客人」與「讀建議」兩條路用，
      //    不分開的話「這個 id 有沒有建議」會被當成「這個客人存不存在」（本測試踩過）
      doc: (id: string) => ({ id, __col: name }),
      count: () => ({
        get: async () => ({ data: () => ({ count: name === 'userTagSuggestions' ? suggestions.length : opts.users.length }) }),
      }),
      get: async () => {
        if (name === 'userTagSuggestions') {
          return {
            docs: suggestions.map(id => ({ id, exists: true, data: () => ({ hasPending: true }) })),
            size: suggestions.length,
            empty: suggestions.length === 0,
          }
        }
        if (name === 'userTags') {
          const rows = opts.userTags ?? []
          return { docs: rows.map(r => ({ id: `${r.userId}_${r.tagId}`, data: () => r })), size: rows.length, empty: !rows.length }
        }
        if (name === 'users') {
          return {
            docs: opts.users.map(u => ({ id: u.id, data: () => ({ displayName: u.displayName, workspaceId: WS }) })),
            size: opts.users.length,
            empty: opts.users.length === 0,
          }
        }
        return { docs: [], size: 0, empty: true }
      },
    }
    return q
  }
  return {
    collection,
    getAll: async (...refs: { id: string, __col: string }[]) => refs.map((r) => {
      if (r.__col === 'users') {
        const u = opts.users.find(x => x.id === r.id)
        return { id: r.id, exists: !!u, data: () => ({ displayName: u?.displayName, workspaceId: WS }) }
      }
      return {
        id: r.id,
        exists: suggestions.includes(r.id),
        data: () => ({ hasPending: suggestions.includes(r.id) }),
      }
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  currentQuery = {}
})

describe('好友列表的「還有幾件事等你決定」', () => {
  it('沒有篩選時＝全工作區待處理建議的位數', async () => {
    vi.mocked(getDb).mockReturnValue(fakeDb({
      suggestedDocIds: [docId(1), docId(2), docId(3), docId(4)],
      users: [{ id: docId(1), displayName: '甲' }, { id: docId(2), displayName: '乙' }],
    }) as any)

    const res: any = await (handler as any)({} as any)

    expect(res.pendingSuggestionTotal).toBe(4)
  })

  it('⛔ 勾了「只看有 AI 建議的」也是同一個數字，不是這一頁的筆數', async () => {
    // 四位有建議，但 users 只回兩位（第二頁、或搜尋字縮小了範圍）
    vi.mocked(getDb).mockReturnValue(fakeDb({
      suggestedDocIds: [docId(1), docId(2), docId(3), docId(4)],
      users: [{ id: docId(1), displayName: '甲' }],
    }) as any)
    currentQuery = { suggested: '1' }

    const res: any = await (handler as any)({} as any)

    expect(res.pendingSuggestionTotal).toBe(4)
  })

  it('⛔ 再疊上標籤篩選、交集只剩 1 位，待辦仍然要說 4', async () => {
    // 交集後只有 docId(1) 同時有建議又有那顆標籤——但「還有幾件事等你決定」沒有變少
    vi.mocked(getDb).mockReturnValue(fakeDb({
      suggestedDocIds: [docId(1), docId(2), docId(3), docId(4)],
      users: [{ id: docId(1), displayName: '甲' }],
      userTags: [{ userId: docId(1), tagId: 'tag-a' }],
    }) as any)
    currentQuery = { suggested: '1', tagIds: 'tag-a' }

    const res: any = await (handler as any)({} as any)

    expect(res.pendingSuggestionTotal).toBe(4)
  })

  it('⛔ 篩到一位都沒有時也要帶著這個數字（那時待辦條最該在）', async () => {
    vi.mocked(getDb).mockReturnValue(fakeDb({
      suggestedDocIds: [docId(1), docId(2)],
      users: [], // 空結果 → 提早 return 的那條路
    }) as any)
    currentQuery = { suggested: '1' }

    const res: any = await (handler as any)({} as any)

    expect(res.users).toEqual([])
    expect(res.pendingSuggestionTotal).toBe(2)
  })

  it('一件都沒有時回 0（待辦條靠這個數字決定要不要出現）', async () => {
    vi.mocked(getDb).mockReturnValue(fakeDb({
      suggestedDocIds: [],
      users: [{ id: docId(1), displayName: '甲' }],
    }) as any)

    const res: any = await (handler as any)({} as any)

    expect(res.pendingSuggestionTotal).toBe(0)
  })
})
