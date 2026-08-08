import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 對話時間軸分段讀的邊界測試。
 *
 * 這支端點的風險全在「接縫」：一段一段讀，訊息靠游標接、事件與群發只能靠時間對進來。
 * 邊界的開閉只要錯一格，就會有事件掉在兩段之間（永遠看不到，而且沒有人會發現），
 * 或同一顆「會話已結束」在相鄰兩段各出現一次。所以這裡專門測接縫，不測渲染。
 */

const WS = 'ws1'
const OTHER_WS = 'ws2'
const LINE_UID = 'U0000000000000000000000000000001'
const CONV_ID = `${WS}_${LINE_UID}`

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS })),
}))

// h3 / nitro 的 auto-import 在 vitest 裡沒有，補最小可用版本（要在 import 端點之前）
let currentQuery: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => currentQuery)
vi.stubGlobal('getRouterParam', () => CONV_ID)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./messages.get')
const { getDb } = await import('~~/server/utils/firebase')

interface FakeMessage {
  id: string
  ms: number
  direction?: 'incoming' | 'outgoing'
  text?: string
}
interface FakeSession {
  id: string
  workspaceId?: string
  /** 這場是誰的（預設就是這支測試的那位客人） */
  userId?: string
  status?: string
  openedMs: number
  closedMs?: number
}
interface FakeEvent {
  id: string
  sessionId: string
  ms: number
  eventType: string
}
interface FakeBroadcast {
  id: string
  ms: number
  sentCount?: number
}

/** 只認測試會用到的那幾種查詢；沒對應到的直接回空，不要假裝支援 */
function makeDb(data: {
  messages: FakeMessage[]
  sessions?: FakeSession[]
  events?: FakeEvent[]
  broadcasts?: FakeBroadcast[]
  currentSessionId?: string
}) {
  const messages = [...data.messages].sort((a, b) => a.ms - b.ms || a.id.localeCompare(b.id))
  const sessions = data.sessions ?? []
  const events = data.events ?? []
  const broadcasts = data.broadcasts ?? []

  const msgDoc = (m: FakeMessage) => ({
    id: m.id,
    data: () => ({
      direction: m.direction ?? 'incoming',
      text: m.text ?? m.id,
      messageType: 'text',
      timestamp: new Date(m.ms),
    }),
  })

  type MsgQuery = {
    dir: 'asc' | 'desc'
    filters: Array<{ op: string, ms: number }>
    startAfterId?: string
    cap?: number
  }

  const runMsgQuery = (q: MsgQuery) => {
    let rows = messages.filter(m => q.filters.every((f) => {
      if (f.op === '<=') return m.ms <= f.ms
      if (f.op === '>=') return m.ms >= f.ms
      if (f.op === '>') return m.ms > f.ms
      return true
    }))
    if (q.dir === 'desc') rows = [...rows].reverse()
    if (q.startAfterId) {
      const idx = rows.findIndex(m => m.id === q.startAfterId)
      rows = idx >= 0 ? rows.slice(idx + 1) : []
    }
    if (q.cap !== undefined) rows = rows.slice(0, q.cap)
    return { docs: rows.map(msgDoc), empty: rows.length === 0 }
  }

  const msgQuery = (q: MsgQuery): any => ({
    orderBy: (_f: string, dir: 'asc' | 'desc' = 'asc') => msgQuery({ ...q, dir }),
    where: (_f: string, op: string, value: Date) =>
      msgQuery({ ...q, filters: [...q.filters, { op, ms: value.getTime() }] }),
    startAfter: (snap: { id: string }) => msgQuery({ ...q, startAfterId: snap.id }),
    limit: (n: number) => msgQuery({ ...q, cap: n }),
    get: async () => runMsgQuery(q),
  })

  const msgCol = {
    ...msgQuery({ dir: 'asc', filters: [] }),
    doc: (id: string) => ({
      get: async () => {
        const found = messages.find(m => m.id === id)
        return found ? { exists: true, ...msgDoc(found) } : { exists: false, data: () => undefined }
      },
    }),
  }

  const sessionSnap = (s: FakeSession) => ({
    id: s.id,
    data: () => ({
      workspaceId: s.workspaceId ?? WS,
      userId: s.userId ?? LINE_UID,
      status: s.status ?? (s.closedMs ? 'closed' : 'bot_handling'),
      openedAt: new Date(s.openedMs),
      closedAt: s.closedMs ? new Date(s.closedMs) : null,
    }),
  })

  const emptyQuery: any = {
    where: () => emptyQuery,
    orderBy: () => emptyQuery,
    limit: () => emptyQuery,
    get: async () => ({ docs: [], empty: true }),
  }

  /**
   * 群發查詢的假實作。刻意照 Firestore 的行為做：**先排序再截斷**——
   * 這正是「沒寫 orderBy 就會留下最舊的那幾筆」的地方，假 db 不模擬這一段就測不出來。
   */
  type BcQuery = { filters: Array<{ op: string, ms: number }>, dir: 'asc' | 'desc', cap?: number }
  const bcQuery = (q: BcQuery): any => ({
    where: (field: string, op: string, value: unknown) =>
      (field === 'completedAt'
        ? bcQuery({ ...q, filters: [...q.filters, { op, ms: (value as Date).getTime() }] })
        : bcQuery(q)),
    orderBy: (_f: string, dir: 'asc' | 'desc' = 'asc') => bcQuery({ ...q, dir }),
    limit: (n: number) => bcQuery({ ...q, cap: n }),
    get: async () => {
      let rows = broadcasts.filter(b => q.filters.every((f) => {
        if (f.op === '>=') return b.ms >= f.ms
        if (f.op === '<=') return b.ms <= f.ms
        return true
      }))
      rows = [...rows].sort((a, b) => (q.dir === 'desc' ? b.ms - a.ms : a.ms - b.ms))
      if (q.cap !== undefined) rows = rows.slice(0, q.cap)
      return {
        docs: rows.map(b => ({
          id: b.id,
          data: () => ({
            completedAt: new Date(b.ms),
            sentCount: b.sentCount ?? 1,
            name: b.id,
          }),
        })),
        empty: rows.length === 0,
      }
    },
  })

  /**
   * 會話查詢：where 會真的套用（userId 與 workspaceId 都認），否則測不出「別人的那場」；
   * orderBy／limit 也照做，端點正常路徑就是「由新到舊取最近 N 場」。
   */
  const sessionsQuery = (f: { ws?: boolean, userId?: string, dir?: 'asc' | 'desc', cap?: number }): any => ({
    where: (field: string, _op: string, value: unknown) => sessionsQuery({
      ...f,
      ws: f.ws || field === 'workspaceId',
      userId: field === 'userId' ? String(value) : f.userId,
    }),
    orderBy: (_field: string, dir: 'asc' | 'desc' = 'asc') => sessionsQuery({ ...f, dir }),
    limit: (n: number) => sessionsQuery({ ...f, cap: n }),
    get: async () => {
      let rows = sessions
      if (f.ws) rows = rows.filter(s => (s.workspaceId ?? WS) === WS)
      if (f.userId) rows = rows.filter(s => (s.userId ?? LINE_UID) === f.userId)
      if (f.dir) rows = [...rows].sort((a, b) => (f.dir === 'desc' ? b.openedMs - a.openedMs : a.openedMs - b.openedMs))
      if (f.cap !== undefined) rows = rows.slice(0, f.cap)
      return { docs: rows.map(sessionSnap), empty: rows.length === 0 }
    },
  })

  const db = {
    collection: (col: string): any => {
      if (col === 'conversations') {
        return {
          doc: (id: string) => ({
            get: async () => ({
              exists: id === CONV_ID,
              data: () => (id === CONV_ID
                ? { workspaceId: WS, currentSessionId: data.currentSessionId ?? '' }
                : undefined),
            }),
            collection: (_sub: string) => msgCol,
          }),
        }
      }
      if (col === 'conversationSessions') {
        return {
          ...sessionsQuery({}),
          doc: (id: string) => ({
            get: async () => {
              const found = sessions.find(s => s.id === id)
              return found ? { exists: true, ...sessionSnap(found) } : { exists: false, data: () => undefined }
            },
          }),
        }
      }
      if (col === 'conversationEvents') {
        return {
          where: (_f: string, _op: string, ids: string[]) => ({
            get: async () => {
              const rows = events.filter(e => ids.includes(e.sessionId))
              return {
                docs: rows.map(e => ({
                  id: e.id,
                  data: () => ({ sessionId: e.sessionId, eventType: e.eventType, timestamp: new Date(e.ms) }),
                })),
                empty: rows.length === 0,
              }
            },
          }),
        }
      }
      if (col === 'broadcasts') return bcQuery({ filters: [], dir: 'asc' })
      return emptyQuery
    },
  }
  return db
}

function useDb(data: Parameters<typeof makeDb>[0]) {
  vi.mocked(getDb).mockReturnValue(makeDb(data) as any)
}

async function call(query: Record<string, unknown> = {}) {
  currentQuery = query
  return await (handler as any)({} as any) as {
    items: Array<{ id: string, type: string, label?: string }>
    hasOlder: boolean
    hasNewer: boolean
    activeSession: { sessionId: string } | null
    session: { sessionId: string, closedAtMs: number } | null
  }
}

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** n 則訊息，每則間隔一分鐘 */
function seriesOf(n: number, startMs = T0): FakeMessage[] {
  return Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, ms: startMs + i * MINUTE }))
}

function messageIds(res: Awaited<ReturnType<typeof call>>): string[] {
  return res.items.filter(i => i.type === 'message').map(i => i.id)
}

beforeEach(() => {
  vi.mocked(getDb).mockReset()
})

describe('對話時間軸：分段讀', () => {
  it('第一段只給最新的那幾則，並說明上面還有', async () => {
    useDb({ messages: seriesOf(100) })
    const res = await call({ limit: 40 })
    expect(messageIds(res)).toEqual(seriesOf(100).slice(60).map(m => m.id))
    expect(res.hasOlder).toBe(true)
    // 沒有錨定任何會話＝看的就是對話的最後一則，下面沒有東西
    expect(res.hasNewer).toBe(false)
  })

  it('往上讀接得起來：不重複、不跳號', async () => {
    useDb({ messages: seriesOf(100) })
    const first = await call({ limit: 40 })
    const second = await call({ limit: 40, beforeId: messageIds(first)[0] })
    expect(messageIds(second)).toEqual(seriesOf(100).slice(20, 60).map(m => m.id))
    expect(second.hasOlder).toBe(true)
    // 帶了 beforeId＝是從更晚的那一段翻上來的，下面當然還有
    expect(second.hasNewer).toBe(true)
    const overlap = messageIds(second).filter(id => messageIds(first).includes(id))
    expect(overlap).toEqual([])
  })

  it('讀到最早那一段就說沒有更早的了，而且第一則之前的「新會話開始」看得到', async () => {
    useDb({
      messages: seriesOf(10),
      sessions: [{ id: 's1', openedMs: T0 - MINUTE }],
      events: [{ id: 'e-open', sessionId: 's1', ms: T0 - MINUTE, eventType: 'conversation_opened' }],
    })
    const res = await call({ limit: 40 })
    expect(res.hasOlder).toBe(false)
    expect(res.items[0]).toMatchObject({ id: 'e-open', label: '新會話開始' })
  })

  it('從會話分頁點進已結束的舊會話：第一段停在那場的尾巴，含「會話已結束」，並告知下面還有', async () => {
    const closedMs = T0 + 5 * MINUTE
    useDb({
      messages: [...seriesOf(6), { id: 'later1', ms: T0 + 3 * HOUR }, { id: 'later2', ms: T0 + 4 * HOUR }],
      sessions: [
        { id: 's1', openedMs: T0, closedMs, status: 'closed' },
        { id: 's2', openedMs: T0 + 3 * HOUR },
      ],
      events: [{ id: 'e-close', sessionId: 's1', ms: closedMs, eventType: 'conversation_closed' }],
    })
    const res = await call({ limit: 40, sessionId: 's1' })
    expect(messageIds(res)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
    expect(res.items.at(-1)).toMatchObject({ id: 'e-close', label: '會話已結束' })
    expect(res.hasNewer).toBe(true)
    expect(res.session).toMatchObject({ sessionId: 's1', closedAtMs: closedMs })
  })

  it('往下讀：落在「這一段最後一則」與「下一則」之間的事件不會掉', async () => {
    const closedMs = T0 + 2 * MINUTE + 30_000
    useDb({
      messages: [{ id: 'm1', ms: T0 }, { id: 'm2', ms: T0 + 2 * MINUTE }, { id: 'm3', ms: T0 + 2 * HOUR }],
      sessions: [{ id: 's1', openedMs: T0, closedMs, status: 'closed' }, { id: 's2', openedMs: T0 + 2 * HOUR }],
      events: [{ id: 'e-close', sessionId: 's1', ms: closedMs, eventType: 'conversation_closed' }],
    })
    const res = await call({ limit: 40, afterId: 'm2' })
    expect(messageIds(res)).toEqual(['m3'])
    // 「會話已結束」在 m2 之後、m3 之前：下界若取這一段最舊的訊息（m3）就會整顆消失
    expect(res.items.map(i => i.id)).toContain('e-close')
    expect(res.hasNewer).toBe(false)
  })

  it('游標那則已被保留期清掉：就停在這裡，不要偷偷跳到別的地方', async () => {
    useDb({ messages: seriesOf(10) })
    const res = await call({ limit: 40, beforeId: 'gone' })
    expect(res.items).toEqual([])
    expect(res.hasOlder).toBe(false)
  })

  it('別的 workspace 的會話不會被算進來', async () => {
    useDb({
      messages: seriesOf(3),
      sessions: [{ id: 'foreign', workspaceId: OTHER_WS, openedMs: T0 }],
      events: [{ id: 'e-foreign', sessionId: 'foreign', ms: T0 + 30_000, eventType: 'conversation_opened' }],
    })
    const res = await call({ limit: 40 })
    expect(res.items.map(i => i.id)).not.toContain('e-foreign')
  })

  it('進行中的那一場會回在 activeSession 上（「全部」分頁的工具列要它）', async () => {
    useDb({
      messages: seriesOf(3),
      sessions: [{ id: 's1', openedMs: T0, status: 'bot_handling' }],
      currentSessionId: 's1',
    })
    const res = await call({ limit: 40 })
    expect(res.activeSession).toMatchObject({ sessionId: 's1', status: 'bot_handling' })
    expect(res.session).toBeNull()
  })

  /**
   * 保留期清掉的只有訊息，會話與事件是永久留著的。老客人被清到只剩幾十則訊息時，
   * 「已經讀到最早了就不設下界」會把他這輩子的每一筆事件都撈出來疊在那幾則訊息上面。
   */
  it('讀到最早一則時，事件只收這一則所屬那一場的，不會把整部歷史倒出來', async () => {
    const recent = T0 + 300 * HOUR
    useDb({
      messages: seriesOf(3, recent), // 舊訊息已被保留期清掉 → hasOlder=false
      sessions: [
        { id: 'old', openedMs: T0, closedMs: T0 + HOUR, status: 'closed' },
        { id: 'now', openedMs: recent - MINUTE },
      ],
      events: [
        { id: 'e-old-open', sessionId: 'old', ms: T0, eventType: 'conversation_opened' },
        { id: 'e-old-close', sessionId: 'old', ms: T0 + HOUR, eventType: 'conversation_closed' },
        { id: 'e-now-open', sessionId: 'now', ms: recent - MINUTE, eventType: 'conversation_opened' },
      ],
    })

    const res = await call({ limit: 40 })
    const ids = res.items.map(i => i.id)

    expect(res.hasOlder).toBe(false)
    // 這一段那場的「新會話開始」要留著（它就落在第一則訊息之前，本來就是不設下界的理由）
    expect(ids).toContain('e-now-open')
    // 幾個月前那場的事件不該跟著出來
    expect(ids).not.toContain('e-old-open')
    expect(ids).not.toContain('e-old-close')
  })

  it('帶別人那場的 sessionId 進來：不當成錨點，也不會回別人那場的資料', async () => {
    const otherUserSession = { id: 'foreign-user', userId: 'U0000000000000000000000000000002', openedMs: T0, closedMs: T0 + HOUR, status: 'closed' }
    useDb({
      messages: seriesOf(3, T0 + 10 * HOUR),
      sessions: [{ id: 'mine', openedMs: T0 + 9 * HOUR }, otherUserSession],
    })

    const res = await call({ limit: 40, sessionId: 'foreign-user' })

    // 別人那場不該出現在工具列，也不該把這位客人的時間軸錨定在那場的結束時間上
    expect(res.session).toBeNull()
    expect(messageIds(res)).toEqual(['m1', 'm2', 'm3'])
  })

  /**
   * 群發泡泡有上限（BROADCAST_JOIN_LIMIT＝20，時間軸不是推播報表）。上限本身沒問題，
   * 問題是「留下哪 20 筆」：範圍條件下 Firestore 的隱含排序是由舊到新，沒有自己指定
   * 由新到舊的話，客人剛收到、客服正在追的那幾封會被截掉，畫面上只剩幾個月前的舊推播。
   */
  it('群發超過上限時留下的是最新的那幾筆，不是最舊的', async () => {
    const broadcasts = Array.from({ length: 25 }, (_, i) => ({
      id: `bc${String(i + 1).padStart(2, '0')}`,
      ms: T0 + i * HOUR,
    }))
    useDb({ messages: seriesOf(3, T0 + 30 * HOUR), broadcasts })

    const res = await call({ limit: 40 })
    const ids = res.items.filter(i => i.type === 'broadcast').map(i => i.id)

    expect(ids).toHaveLength(20)
    expect(ids).toContain('bc-bc25') // 最新的那封一定要在
    expect(ids).not.toContain('bc-bc01') // 最舊的那幾封才是該被截掉的
  })
})
