import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 會話列表「未讀紅點時間」（unreadAt）的來源測試。
 *
 * 這裡專測一件事：紅點的時間**不可以**跟著 lastActivityAt 走。
 * lastActivityAt 是「這場有沒有動靜」——客人按按鈕、客服接手／交還／結案、
 * 半夜 auto-handback、24 小時過期自動關場都會把它往前推；但紅點的另一半條件
 * （lastDirection）只在真的有人講話時才變。兩邊來源不同，就會出現
 * 「客人是最後講話的人」永遠成立、時間卻一直跳 → 看完的列反覆變紅。
 *
 * 所以 unreadAt 必須跟 lastMessage / lastDirection 同源（進行中那場＝對話文件），
 * 已結束的場一律 null（客人再開口會開新的一場，舊的不可能還在等我們回）。
 */

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'
const CONV_ID = `${WS}_${LINE_UID}`

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS })),
}))

let currentQuery: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => currentQuery)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./sessions.get')
const { getDb } = await import('~~/server/utils/firebase')

interface SessionRow { sessionId: string, unreadAt: unknown, lastMessage: string, lastDirection: string }

/** 只做這支端點會走到的鏈：where/orderBy/limit/count/get，其餘一律回自己 */
function fakeDb(opts: {
  sessions: { id: string, data: Record<string, unknown> }[]
  conv: Record<string, unknown>
}) {
  const snap = (docs: { id: string, data: () => unknown }[]) =>
    ({ docs, empty: docs.length === 0, size: docs.length })
  const toDocs = (rows: { id: string, data: Record<string, unknown> }[]) =>
    rows.map(r => ({ id: r.id, data: () => r.data }))

  const collection = (name: string) => {
    const rows = name === 'conversationSessions'
      ? opts.sessions
      : name === 'conversations'
        ? [{ id: CONV_ID, data: opts.conv }]
        : [{ id: CONV_ID, data: { displayName: '小明', pictureUrl: '' } }]
    const q: any = {
      where: () => q,
      orderBy: () => q,
      offset: () => q,
      limit: () => q,
      count: () => ({ get: async () => ({ data: () => ({ count: rows.length }) }) }),
      get: async () => snap(toDocs(rows)),
    }
    return q
  }
  return { collection } as any
}

/** 客人 10:00 傳了最後一則訊息；這一場之後又發生了什麼由測試各自決定 */
const CUSTOMER_MSG_AT = new Date('2026-08-11T10:00:00Z')
const BASE_CONV = {
  workspaceId: WS,
  userId: LINE_UID,
  lastMessage: '請問還有貨嗎',
  lastDirection: 'incoming',
  lastMessageAt: CUSTOMER_MSG_AT,
}

async function runList(): Promise<SessionRow[]> {
  const res: any = await (handler as any)({})
  return res.sessions
}

beforeEach(() => {
  currentQuery = { status: 'human_handling' }
})

describe('會話列表的未讀時間（unreadAt）', () => {
  it('進行中那場：拿對話的最後一則訊息時間，不受 lastActivityAt 被推進影響', async () => {
    // 客服 10:05 按了接手／結案之類的動作 → lastActivityAt 跳到 10:05，但沒有人講話
    vi.mocked(getDb).mockReturnValue(fakeDb({
      conv: { ...BASE_CONV, currentSessionId: 's1' },
      sessions: [{
        id: 's1',
        data: {
          workspaceId: WS,
          userId: LINE_UID,
          status: 'human_handling',
          lastActivityAt: new Date('2026-08-11T10:05:00Z'),
        },
      }],
    }))

    const [row] = await runList()
    expect(row!.unreadAt).toEqual(CUSTOMER_MSG_AT)
    // 跟摘要那兩個欄位同源＝紅點的兩個條件對得上
    expect(row!.lastMessage).toBe('請問還有貨嗎')
    expect(row!.lastDirection).toBe('incoming')
  })

  it('已結束（不是進行中那場）：unreadAt 為 null，不亮紅點', async () => {
    // 客人今天又來訊 → 開了新的一場 s2，舊的 s1 被關掉時 lastActivityAt 被蓋成當下。
    // 舊那場的方向仍是「客人」，若拿 lastActivityAt 當基準就會整場復活。
    vi.mocked(getDb).mockReturnValue(fakeDb({
      conv: { ...BASE_CONV, currentSessionId: 's2' },
      sessions: [{
        id: 's1',
        data: {
          workspaceId: WS,
          userId: LINE_UID,
          status: 'closed',
          lastDirection: 'incoming',
          lastMessage: '上一場的最後一句',
          lastActivityAt: new Date('2026-08-11T23:59:00Z'),
        },
      }],
    }))

    const [row] = await runList()
    expect(row!.unreadAt).toBeNull()
    // 摘要照舊讀自己身上的快照，不因為不亮紅點就留白
    expect(row!.lastMessage).toBe('上一場的最後一句')
  })

  it('對話文件還沒有最後訊息時間：回 null，不拿動靜時間充數', async () => {
    vi.mocked(getDb).mockReturnValue(fakeDb({
      conv: { ...BASE_CONV, lastMessageAt: undefined, currentSessionId: 's1' },
      sessions: [{
        id: 's1',
        data: {
          workspaceId: WS,
          userId: LINE_UID,
          status: 'human_handling',
          lastActivityAt: new Date('2026-08-11T10:05:00Z'),
        },
      }],
    }))

    const [row] = await runList()
    expect(row!.unreadAt).toBeNull()
  })
})
