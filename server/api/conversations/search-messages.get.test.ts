import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pickMessageSearchToken } from '~~/shared/message-search'

/**
 * 對話內容搜尋。這裡鎖的是四件「錯了也不會有人發現」的事：
 *
 * 1. 片段查詢只是縮小候選，**整段關鍵字**才是命中判準（搜「退貨流程」不該回
 *    只講過「退貨」的那位客人）。
 * 2. 查詢真的帶了 workspaceId——collectionGroup 掃的是整個資料庫，漏了這個條件
 *    就會把別家租戶的對話端到這一家的畫面上。
 * 3. 索引沒部署時回 unavailable，**不是空結果**：空結果等於告訴客服「客人沒講過」。
 * 4. 掃描撞上限時 truncated 要帶回去（同款沉默截斷這個專案已經踩過三次）。
 */

const WS = 'ws1'
const OTHER_WS = 'ws2'
const uid = (n: number) => `U${String(n).padStart(31, '0')}`
const docId = (n: number, ws = WS) => `${ws}_${uid(n)}`

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS })),
}))

let currentQuery: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => currentQuery)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./search-messages.get')
const { getDb } = await import('~~/server/utils/firebase')

type FakeMessage = {
  id: string
  /** 這則掛在哪一個 conversations 文件底下 */
  conv: string
  text: string
  ms: number
  direction?: 'incoming' | 'outgoing'
  mediaDescription?: string
}

const ts = (ms: number) => ({ toMillis: () => ms })

/** 這一輪 collectionGroup 查詢實際帶了哪些條件（測試要驗這個，不是只驗結果） */
let lastQuery: { wheres: unknown[][], orderBy: unknown[], limit: number, select: string[] }

function fakeDb(opts: {
  messages: FakeMessage[]
  users?: Record<string, Record<string, unknown>>
  /** 模擬「索引沒部署」：查詢直接爆 */
  queryFails?: boolean
  /** messageSearchIndex/{ws} 狀態文件 */
  state?: Record<string, unknown> | null
}) {
  const users = opts.users ?? {}
  return {
    collectionGroup: (name: string) => {
      const q: any = {
        where: (...args: unknown[]) => { lastQuery.wheres.push(args); return q },
        orderBy: (...args: unknown[]) => { lastQuery.orderBy = args; return q },
        limit: (n: number) => { lastQuery.limit = n; return q },
        select: (...fields: string[]) => { lastQuery.select = fields; return q },
        get: async () => {
          if (opts.queryFails) throw new Error('FAILED_PRECONDITION: The query requires an index.')
          if (name !== 'messages') return { docs: [] }
          const docs = [...opts.messages]
            .sort((a, b) => b.ms - a.ms)
            .slice(0, lastQuery.limit)
            .map(m => ({
              id: m.id,
              ref: { parent: { parent: { id: m.conv } } },
              data: () => ({
                text: m.text,
                mediaDescription: m.mediaDescription ?? '',
                direction: m.direction ?? 'incoming',
                timestamp: ts(m.ms),
              }),
            }))
          return { docs }
        },
      }
      return q
    },
    collection: (name: string) => ({
      doc: (id: string) => ({
        id,
        get: async () => ({
          exists: name === 'messageSearchIndex' ? Boolean(opts.state) : true,
          data: () => (name === 'messageSearchIndex' ? opts.state ?? undefined : users[id]),
        }),
      }),
    }),
    getAll: async (...refs: { id: string }[]) =>
      refs.map(ref => ({ id: ref.id, exists: Boolean(users[ref.id]), data: () => users[ref.id] })),
  } as any
}

async function search(q: string): Promise<any> {
  currentQuery = { q }
  return await handler({} as any)
}

describe('conversations/search-messages', () => {
  beforeEach(() => {
    lastQuery = { wheres: [], orderBy: [], limit: 0, select: [] }
    vi.mocked(getDb).mockReturnValue(fakeDb({
      messages: [
        { id: 'm1', conv: docId(1), text: '我要退貨可以嗎', ms: 300 },
        { id: 'm2', conv: docId(1), text: '好的，退貨流程是這樣', ms: 400, direction: 'outgoing' },
        { id: 'm3', conv: docId(2), text: '退貨很麻煩耶', ms: 200 },
        // 別家租戶的對話：路徑前綴對不上，不可以出現在結果裡
        { id: 'm4', conv: docId(9, OTHER_WS), text: '我也要退貨流程', ms: 500 },
      ],
      users: {
        [docId(1)]: { displayName: '小江', pictureUrl: 'http://a/1.png' },
        [docId(2)]: { displayName: '陳先生' },
      },
      state: { completedAt: ts(1000), oldestIndexedMs: 123, indexedMessages: 42 },
    }))
  })

  it('查詢帶了 workspaceId、片段、時間排序與欄位裁切', async () => {
    await search('退貨流程')
    expect(lastQuery.wheres).toEqual([
      ['workspaceId', '==', WS],
      ['searchTokens', 'array-contains', pickMessageSearchToken('退貨流程')],
    ])
    expect(lastQuery.orderBy).toEqual(['timestamp', 'desc'])
    expect(lastQuery.select).toContain('text')
    expect(lastQuery.select).not.toContain('payload')
  })

  it('只有整段關鍵字命中才算：只講過「退貨」的那位不會出現', async () => {
    const res = await search('退貨流程')
    expect(res.status).toBe('ok')
    expect(res.rows.map((r: any) => r.userId)).toEqual([docId(1)])
    expect(res.rows[0].displayName).toBe('小江')
  })

  it('句子中間命中也找得到，摘要以命中的字為中心', async () => {
    const res = await search('退貨')
    const names = res.rows.map((r: any) => r.displayName)
    expect(names).toEqual(['小江', '陳先生'])
    expect(res.rows[0].snippet.match).toBe('退貨')
    // 同一位客人有兩則命中：列最新那一則、並且數得出來有幾則
    expect(res.rows[0].messageId).toBe('m2')
    expect(res.rows[0].matchCount).toBe(2)
  })

  it('⛔ 別家租戶路徑下的訊息一律排除', async () => {
    const res = await search('退貨流程')
    expect(res.rows.every((r: any) => r.userId.startsWith(`${WS}_`))).toBe(true)
  })

  it('一個字回 too_short，不是「無符合結果」', async () => {
    const res = await search('退')
    expect(res.status).toBe('too_short')
    expect(res.rows).toEqual([])
  })

  it('⛔ 索引沒部署要回 unavailable（回空結果等於說客人沒講過）', async () => {
    vi.mocked(getDb).mockReturnValue(fakeDb({ messages: [], queryFails: true }))
    const res = await search('退貨')
    expect(res.status).toBe('unavailable')
    expect(res.rows).toEqual([])
  })

  it('候選撞到掃描上限要回報截斷與掃到哪一天', async () => {
    const many: FakeMessage[] = Array.from({ length: 600 }, (_, i) => ({
      id: `x${i}`,
      conv: docId(i % 3 + 1),
      text: '訂單查詢',
      ms: 100000 - i,
    }))
    vi.mocked(getDb).mockReturnValue(fakeDb({ messages: many, users: {} }))
    const res = await search('訂單')
    expect(res.truncated).toBe(true)
    expect(res.scanned).toBe(500)
    // 最舊那一筆的時間要帶回去，畫面才講得出「只找到 X 月 X 日為止」
    expect(res.oldestScannedMs).toBe(100000 - 499)
  })

  it('回填狀態要一起回報（沒回填時畫面要降級說明）', async () => {
    const withState = await search('退貨')
    expect(withState.backfill).toEqual({ done: true, indexedFromMs: 123 })

    vi.mocked(getDb).mockReturnValue(fakeDb({ messages: [], state: null }))
    const without = await search('退貨')
    expect(without.backfill).toEqual({ done: false, indexedFromMs: 0 })
  })
})
