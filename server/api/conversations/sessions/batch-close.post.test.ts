import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 批次結束會話。這支測的全部是「批次特有的風險」，單場結束的行為本身由
 * conversation-session.close.test.ts 顧（這裡刻意 mock 掉它，只驗有沒有被正確地叫）：
 *
 * 1. 歸屬要逐筆驗——不驗就是「知道 id 就能關掉別家官方帳號的對話」。
 * 2. 三堆要分清楚：關掉的／不用關的（已結束、查不到）／想關但炸掉的。
 *    這個專案為「過濾掉東西卻不吭聲」付過三次帳，批次只回 ok 是同一種病。
 * 3. 一筆炸掉不可以讓整批停下來。
 * 4. 上限要擋（成本與 Lambda 逾時）。
 */

const WS = 'ws1'
const OTHER_WS = 'ws2'

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS, uid: 'admin1' })),
}))
vi.mock('~~/server/utils/conversation-session', () => ({
  closeConversationSession: vi.fn(async () => {}),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

let currentBody: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => currentBody)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./batch-close.post')
const { getDb } = await import('~~/server/utils/firebase')
const { closeConversationSession } = await import('~~/server/utils/conversation-session')
const { writeAuditLog } = await import('~~/server/utils/audit-log')

/** 只做這支端點會走到的鏈：collection().doc() 拿 ref、db.getAll() 依 ref 回快照 */
function fakeDb(sessions: Record<string, Record<string, unknown> | null>) {
  return {
    collection: () => ({ doc: (id: string) => ({ id }) }),
    getAll: async (...refs: { id: string }[]) =>
      refs.map(ref => ({
        id: ref.id,
        exists: Boolean(sessions[ref.id]),
        data: () => sessions[ref.id] ?? undefined,
      })),
  } as any
}

const openSession = (userId: string, workspaceId = WS) =>
  ({ workspaceId, userId, status: 'human_handling' })

beforeEach(() => {
  vi.mocked(closeConversationSession).mockClear()
  vi.mocked(closeConversationSession).mockImplementation(async () => {})
  vi.mocked(writeAuditLog).mockClear()
  currentBody = {}
})

describe('POST /api/conversations/sessions/batch-close', () => {
  it('關掉屬於這個官方帳號、還沒結束的那幾場', async () => {
    vi.mocked(getDb).mockReturnValue(fakeDb({
      s1: openSession('U1'),
      s2: openSession('U2'),
    }))
    currentBody = { sessionIds: ['s1', 's2'] }

    const res: any = await (handler as any)({})

    expect(res.done).toBe(2)
    expect(res.doneIds.sort()).toEqual(['s1', 's2'])
    expect(res.skipped).toEqual([])
    expect(res.failed).toEqual([])
    // 剛讀到的那份要帶下去，不然同一份文件會被讀第二趟
    expect(closeConversationSession).toHaveBeenCalledWith('s1', 'U1', { session: expect.objectContaining({ userId: 'U1' }) })
  })

  it('⛔ 別家官方帳號的會話一律不關，回報成「查不到」', async () => {
    vi.mocked(getDb).mockReturnValue(fakeDb({
      s1: openSession('U1'),
      s2: openSession('U2', OTHER_WS),
    }))
    currentBody = { sessionIds: ['s1', 's2'] }

    const res: any = await (handler as any)({})

    expect(res.done).toBe(1)
    expect(res.skipped).toEqual([{ id: 's2', reason: 'not_found' }])
    expect(closeConversationSession).toHaveBeenCalledTimes(1)
  })

  it('已經結束的場算「略過」不算失敗（多半是同事先關掉了）', async () => {
    vi.mocked(getDb).mockReturnValue(fakeDb({
      s1: { workspaceId: WS, userId: 'U1', status: 'closed' },
      s2: openSession('U2'),
      s3: null,
    }))
    currentBody = { sessionIds: ['s1', 's2', 's3'] }

    const res: any = await (handler as any)({})

    expect(res.done).toBe(1)
    expect(res.skipped).toEqual([
      { id: 's1', reason: 'already_closed' },
      { id: 's3', reason: 'not_found' },
    ])
    expect(res.failed).toEqual([])
  })

  it('一場炸掉時其餘照做，失敗的那一筆原樣回報（不可以整批中斷）', async () => {
    vi.mocked(getDb).mockReturnValue(fakeDb({
      s1: openSession('U1'),
      s2: openSession('U2'),
      s3: openSession('U3'),
    }))
    vi.mocked(closeConversationSession).mockImplementation(async (sessionId: string) => {
      if (sessionId === 's2') throw new Error('DEADLINE_EXCEEDED')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    currentBody = { sessionIds: ['s1', 's2', 's3'] }

    const res: any = await (handler as any)({})

    expect(res.done).toBe(2)
    expect(res.doneIds.sort()).toEqual(['s1', 's3'])
    expect(res.failed).toEqual([{ id: 's2', message: 'DEADLINE_EXCEEDED' }])
  })

  it('送來重複的 id 只算一筆（畫面重繪時勾兩次不該關兩遍）', async () => {
    vi.mocked(getDb).mockReturnValue(fakeDb({ s1: openSession('U1') }))
    currentBody = { sessionIds: ['s1', 's1', ' s1 '] }

    const res: any = await (handler as any)({})

    expect(res.requested).toBe(1)
    expect(closeConversationSession).toHaveBeenCalledTimes(1)
  })

  it('超過一次上限直接擋下（成本與逾時），空陣列也擋', async () => {
    vi.mocked(getDb).mockReturnValue(fakeDb({}))
    currentBody = { sessionIds: Array.from({ length: 101 }, (_, i) => `s${i}`) }
    await expect((handler as any)({})).rejects.toThrow(/最多 100 場/)

    currentBody = { sessionIds: [] }
    await expect((handler as any)({})).rejects.toThrow(/sessionIds required/)
  })

  it('真的關掉東西才留稽核（沒動到就不留噪音）', async () => {
    vi.mocked(getDb).mockReturnValue(fakeDb({
      s1: { workspaceId: WS, userId: 'U1', status: 'closed' },
    }))
    currentBody = { sessionIds: ['s1'] }
    await (handler as any)({})
    expect(writeAuditLog).not.toHaveBeenCalled()

    vi.mocked(getDb).mockReturnValue(fakeDb({ s2: openSession('U2') }))
    currentBody = { sessionIds: ['s2'] }
    await (handler as any)({})
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'conversations/sessions.batchClose',
      workspaceId: WS,
      uid: 'admin1',
    }))
  })
})
