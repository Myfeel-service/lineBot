import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 對話列表「搜尋」的行為測試。
 *
 * 2026-08-17 搜尋改版：從「掃 conversations 邊掃邊 join users」改成「掃 users、
 * 命中才照編號讀對話」。這裡鎖住改版後不能退步的四件事：
 *
 * 1. 子字串命中：打「江」要找得到「小江」，不是只比開頭。
 * 2. 比對 LINE userId 時**不含 workspace 前綴**——舊版連前綴一起比，
 *    搜尋字跟 workspaceId 撞字（例如搜「w」）會把整個清單都判成命中。
 * 3. 有 user 沒對話（加好友沒開口）不能出現在結果裡。
 * 4. 結果照 lastMessageAt 新→舊排，跟不搜尋時的清單同一個順序邏輯。
 */

const WS = 'ws1'
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

type Row = { userId: string, displayName: string, lastMessage: string }

const ts = (ms: number) => ({ toMillis: () => ms })

/** 只做搜尋路徑會走到的鏈：users 的 where/select/get、conversations 的 doc + db.getAll */
function fakeDb(opts: {
  users: { id: string, data: Record<string, unknown> }[]
  convs: Record<string, Record<string, unknown>>
}) {
  const collection = (name: string) => {
    const q: any = {
      where: () => q,
      orderBy: () => q,
      select: () => q,
      limit: () => q,
      doc: (id: string) => ({ id }),
      get: async () => {
        const rows = name === 'users' ? opts.users : []
        return { docs: rows.map(r => ({ id: r.id, data: () => r.data })), size: rows.length, empty: rows.length === 0 }
      },
    }
    return q
  }
  return {
    collection,
    getAll: async (...refs: { id: string }[]) =>
      refs.map(ref => ({
        id: ref.id,
        exists: Boolean(opts.convs[ref.id]),
        data: () => opts.convs[ref.id],
      })),
  } as any
}

async function search(term: string): Promise<{ conversations: Row[], total: number }> {
  currentQuery = { search: term }
  return await handler({} as any) as any
}

describe('conversations/list 搜尋（掃 users 版）', () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReturnValue(fakeDb({
      users: [
        { id: docId(1), data: { displayName: '小江', pictureUrl: '', isBlocked: false } },
        { id: docId(2), data: { displayName: '江小姐', pictureUrl: '', isBlocked: false } },
        { id: docId(3), data: { displayName: '陳先生', pictureUrl: '', isBlocked: false } },
        // 加好友沒開口：有 user、沒有 conversations 文件
        { id: docId(4), data: { displayName: '江路人', pictureUrl: '', isBlocked: false } },
      ],
      convs: {
        [docId(1)]: { workspaceId: WS, lastMessage: '哈囉', lastDirection: 'incoming', lastMessageAt: ts(1000) },
        [docId(2)]: { workspaceId: WS, lastMessage: '想問訂單', lastDirection: 'incoming', lastMessageAt: ts(2000) },
        [docId(3)]: { workspaceId: WS, lastMessage: '謝謝', lastDirection: 'outgoing', lastMessageAt: ts(3000) },
      },
    }))
  })

  it('名字中間的字也要命中，且照 lastMessageAt 新→舊排', async () => {
    const res = await search('江')
    expect(res.conversations.map(c => c.displayName)).toEqual(['江小姐', '小江'])
    expect(res.total).toBe(2)
  })

  it('沒有對話文件的 user 不出現在結果裡', async () => {
    const res = await search('江路人')
    expect(res.conversations).toEqual([])
    expect(res.total).toBe(0)
  })

  it('搜 LINE userId 片段找得到人', async () => {
    // uid(3) 尾碼是 …0003，搜「00003」只該命中陳先生
    const res = await search('00003')
    expect(res.conversations.map(c => c.displayName)).toEqual(['陳先生'])
  })

  it('搜尋字撞 workspaceId 前綴不可整批命中', async () => {
    // 所有 doc id 都以 ws1_ 開頭；若連前綴一起比，「ws1」會回全部三筆
    const res = await search('ws1')
    expect(res.conversations).toEqual([])
  })
})
