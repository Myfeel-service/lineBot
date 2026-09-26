import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 開通步驟紀錄的接收端（`C-250`③）。
 * 1. 沒帶帳號（打造那一趟前幾格）只驗登入；帶了帳號就驗他看得到那個帳號、記驗過的那一個。
 * 2. 不認得的事件丟掉，⛔ 但要回報／記下丟了幾個（沉默死亡）。
 * 3. 附帶資料照 `sanitizeEventProps` 收，丟掉的欄位數記在那一筆上。
 */

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireAuth: vi.fn(async () => ({ uid: 'u-auth' })),
  requireWorkspaceAccess: vi.fn(async () => ({ uid: 'u-ws', workspaceId: 'ws-verified' })),
}))
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
}))

let currentBody: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => currentBody)

const { default: handler } = await import('./events.post')
const { getDb } = await import('~~/server/utils/firebase')
const auth = await import('~~/server/utils/workspace-auth')

function fakeDb() {
  const written: Record<string, unknown>[] = []
  let commits = 0
  const db = {
    collection: (name: string) => ({ doc: () => ({ name }) }),
    batch: () => ({
      set: (_ref: unknown, data: Record<string, unknown>) => { written.push(data) },
      commit: async () => { commits++ },
    }),
  }
  return { db, written, commits: () => commits }
}

let f: ReturnType<typeof fakeDb>
beforeEach(() => {
  f = fakeDb()
  vi.mocked(getDb).mockReturnValue(f.db as never)
  vi.mocked(auth.requireAuth).mockClear()
  vi.mocked(auth.requireWorkspaceAccess).mockClear()
})

describe('POST /api/onboarding/events', () => {
  it('還沒有帳號：只驗登入，workspaceId 記 null', async () => {
    currentBody = { sessionId: 's1', flow: 'build', events: [{ event: 'build_start', props: { mode: 'fresh' }, at: 123 }] }
    const r = await (handler as any)({})
    expect(auth.requireAuth).toHaveBeenCalledTimes(1)
    expect(auth.requireWorkspaceAccess).not.toHaveBeenCalled()
    expect(r).toEqual({ written: 1, unknown: 0, tooMany: 0 })
    expect(f.written[0]).toMatchObject({ workspaceId: null, uid: 'u-auth', sessionId: 's1', flow: 'build', event: 'build_start', props: { mode: 'fresh' }, clientAt: 123, at: '__ts__' })
  })

  it('帶了帳號：驗得過才收，記的是守衛驗過的那一個', async () => {
    currentBody = { sessionId: 's2', flow: 'line', workspaceId: 'ws-claimed', events: [{ event: 'line_start', props: { entry: 'band' } }] }
    await (handler as any)({})
    expect(auth.requireWorkspaceAccess).toHaveBeenCalledTimes(1)
    expect(f.written[0]).toMatchObject({ workspaceId: 'ws-verified', uid: 'u-ws', flow: 'line' })
  })

  it('守衛擋下＝整批不寫', async () => {
    vi.mocked(auth.requireWorkspaceAccess).mockRejectedValueOnce(Object.assign(new Error('forbidden'), { statusCode: 403 }))
    currentBody = { workspaceId: 'someone-else', events: [{ event: 'line_start' }] }
    await expect((handler as any)({})).rejects.toThrow('forbidden')
    expect(f.written).toHaveLength(0)
  })

  it('不認得的事件丟掉並回報數量；認得的照寫', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    currentBody = { flow: 'build', events: [{ event: 'build_start' }, { event: 'typo_event' }, { event: 'toString' }, 'garbage'] }
    const r = await (handler as any)({})
    expect(r).toEqual({ written: 1, unknown: 3, tooMany: 0 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('丟掉 3 個不認得的事件'))
    warn.mockRestore()
  })

  it('一批最多 30 個，多的算 tooMany', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    currentBody = { events: Array.from({ length: 34 }, () => ({ event: 'profile_answer' })) }
    const r = await (handler as any)({})
    expect(r).toEqual({ written: 30, unknown: 0, tooMany: 4 })
    warn.mockRestore()
  })

  it('附帶資料被丟掉的欄位數記在那一筆上；flow 不認得的算 other', async () => {
    currentBody = { flow: 'hacker', events: [{ event: 'profile_answer', props: { field: 'products', answer: { text: '他打的字' } } }] }
    await (handler as any)({})
    expect(f.written[0]).toMatchObject({ flow: 'other', props: { field: 'products' }, droppedProps: 1 })
  })

  it('一個都沒收到就不 commit', async () => {
    currentBody = { events: [] }
    await (handler as any)({})
    expect(f.commits()).toBe(0)
  })
})
