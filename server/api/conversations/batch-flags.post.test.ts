import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 批次標記／取消待跟進。
 *
 * 測的是批次特有的三件事：
 * 1. 歸屬逐筆驗（別家官方帳號的對話標不到）。
 * 2. 「本來就是這個標記」要回報成略過，不是默默算成功——回報 8 筆成功、實際只動了 6 筆，
 *    客服下次就不會相信這個數字。
 * 3. 取消標記要真的把欄位刪掉（`orderBy('followUpAt')` 是靠欄位存不存在在篩的，
 *    寫 false 進去會讓「只看待跟進」永遠撈得到它）。
 */

const WS = 'ws1'
const OTHER_WS = 'ws2'
const UID = 'admin1'

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS, uid: UID })),
}))
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__serverTimestamp__',
    delete: () => '__delete__',
  },
}))

let currentBody: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => currentBody)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./batch-flags.post')
const { getDb } = await import('~~/server/utils/firebase')

interface Written { id: string, data: Record<string, unknown> }

function fakeDb(convs: Record<string, Record<string, unknown> | null>) {
  const written: Written[] = []
  const commits: number[] = []
  const db = {
    collection: () => ({ doc: (id: string) => ({ id }) }),
    getAll: async (...refs: { id: string }[]) =>
      refs.map(ref => ({
        id: ref.id,
        exists: Boolean(convs[ref.id]),
        data: () => convs[ref.id] ?? undefined,
      })),
    batch: () => {
      let ops = 0
      return {
        update: (ref: { id: string }, data: Record<string, unknown>) => {
          written.push({ id: ref.id, data })
          ops++
        },
        commit: async () => { commits.push(ops) },
      }
    },
  } as any
  return { db, written, commits }
}

beforeEach(() => {
  currentBody = {}
})

describe('POST /api/conversations/batch-flags', () => {
  it('標記待跟進：只寫沒標過的那幾筆，已標的算略過', async () => {
    const { db, written } = fakeDb({
      [`${WS}_U1`]: { workspaceId: WS },
      [`${WS}_U2`]: { workspaceId: WS, followUpAt: new Date() },
    })
    vi.mocked(getDb).mockReturnValue(db)
    currentBody = { userIds: [`${WS}_U1`, `${WS}_U2`], followUp: true }

    const res: any = await (handler as any)({})

    expect(res.done).toBe(1)
    expect(res.doneIds).toEqual([`${WS}_U1`])
    expect(res.skipped).toEqual([{ id: `${WS}_U2`, reason: 'already_set' }])
    expect(written).toEqual([{
      id: `${WS}_U1`,
      data: { followUpAt: '__serverTimestamp__', followUpBy: UID },
    }])
  })

  it('取消待跟進要刪掉欄位，不是寫 false（否則「只看待跟進」還撈得到）', async () => {
    const { db, written } = fakeDb({ [`${WS}_U1`]: { workspaceId: WS, followUpAt: new Date() } })
    vi.mocked(getDb).mockReturnValue(db)
    currentBody = { userIds: [`${WS}_U1`], followUp: false }

    const res: any = await (handler as any)({})

    expect(res.done).toBe(1)
    expect(written[0]!.data).toEqual({ followUpAt: '__delete__', followUpBy: '__delete__' })
  })

  it('⛔ 別家官方帳號、或查不到的對話一律不寫', async () => {
    const { db, written } = fakeDb({
      [`${WS}_U1`]: { workspaceId: OTHER_WS },
      [`${WS}_U2`]: null,
    })
    vi.mocked(getDb).mockReturnValue(db)
    currentBody = { userIds: [`${WS}_U1`, `${WS}_U2`], followUp: true }

    const res: any = await (handler as any)({})

    expect(res.done).toBe(0)
    expect(res.skipped).toEqual([
      { id: `${WS}_U1`, reason: 'not_found' },
      { id: `${WS}_U2`, reason: 'not_found' },
    ])
    expect(written).toEqual([])
  })

  it('LINE userId 與對話主鍵混著送只算一筆（正規化後去重）', async () => {
    const { db } = fakeDb({ [`${WS}_U1`]: { workspaceId: WS } })
    vi.mocked(getDb).mockReturnValue(db)
    currentBody = { userIds: ['U1', `${WS}_U1`], followUp: true }

    const res: any = await (handler as any)({})

    expect(res.requested).toBe(1)
    expect(res.done).toBe(1)
  })

  it('followUp 沒帶或不是布林就擋下（不猜要標還是要取消）', async () => {
    const { db } = fakeDb({})
    vi.mocked(getDb).mockReturnValue(db)
    currentBody = { userIds: [`${WS}_U1`] }
    await expect((handler as any)({})).rejects.toThrow(/followUp/)

    currentBody = { userIds: Array.from({ length: 101 }, (_, i) => `${WS}_U${i}`), followUp: true }
    await expect((handler as any)({})).rejects.toThrow(/最多 100 筆/)
  })
})
