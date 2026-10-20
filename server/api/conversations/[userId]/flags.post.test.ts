import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 單筆「待跟進」（`H-17`：原本的釘選改名，欄位沿用 `pinnedAt`）。
 * 1. 寫的是 pinnedAt；取消是刪欄位。
 * 2. 舊的 followUp 參數不認（帶了就 400，不會默默寫進已下架的欄位）。
 * 3. 50 筆上限：只有「從沒標變成標」才擋，用的是待跟進的說法。
 */

const WS = 'ws1'
const UID = 'agent1'

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: UID })),
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
vi.stubGlobal('getRouterParam', () => 'U1')
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./flags.post')
const { getDb } = await import('~~/server/utils/firebase')

function fakeDb(conv: Record<string, unknown> | null, pinnedCount = 0) {
  const updates: Record<string, unknown>[] = []
  const query = () => ({
    where: () => query(),
    orderBy: () => query(),
    count: () => ({ get: async () => ({ data: () => ({ count: pinnedCount }) }) }),
  })
  const db = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: !!conv, data: () => conv ?? undefined }),
        update: async (u: Record<string, unknown>) => { updates.push(u) },
      }),
      ...query(),
    }),
  } as any
  return { db, updates }
}

beforeEach(() => { currentBody = {} })

describe('POST /api/conversations/:userId/flags（待跟進）', () => {
  it('標記待跟進＝寫 pinnedAt／pinnedBy，回 pinned:true', async () => {
    const { db, updates } = fakeDb({ workspaceId: WS })
    vi.mocked(getDb).mockReturnValue(db)
    currentBody = { pinned: true }

    const res: any = await (handler as any)({})

    expect(res).toEqual({ ok: true, userId: `${WS}_U1`, pinned: true })
    expect(updates).toEqual([{ pinnedAt: '__serverTimestamp__', pinnedBy: UID }])
  })

  it('取消待跟進＝刪欄位', async () => {
    const { db, updates } = fakeDb({ workspaceId: WS, pinnedAt: new Date() })
    vi.mocked(getDb).mockReturnValue(db)
    currentBody = { pinned: false }

    await (handler as any)({})

    expect(updates).toEqual([{ pinnedAt: '__delete__', pinnedBy: '__delete__' }])
  })

  it('⛔ 舊的 followUp 參數不認：400，什麼都不寫', async () => {
    const { db, updates } = fakeDb({ workspaceId: WS })
    vi.mocked(getDb).mockReturnValue(db)
    currentBody = { followUp: true }

    await expect((handler as any)({})).rejects.toThrow(/pinned/)
    expect(updates).toEqual([])
  })

  it('標滿 50 筆再標 → 409，講的是待跟進（不再講釘選）', async () => {
    const { db, updates } = fakeDb({ workspaceId: WS }, 50)
    vi.mocked(getDb).mockReturnValue(db)
    currentBody = { pinned: true }

    await expect((handler as any)({})).rejects.toMatchObject({
      statusCode: 409,
      statusMessage: '待跟進最多 50 筆，請先取消一些再標',
    })
    expect(updates).toEqual([])
  })

  it('已經標著的重複送出不被上限擋', async () => {
    const { db, updates } = fakeDb({ workspaceId: WS, pinnedAt: new Date() }, 50)
    vi.mocked(getDb).mockReturnValue(db)
    currentBody = { pinned: true }

    await (handler as any)({})

    expect(updates).toHaveLength(1)
  })

  it('別家官方帳號的對話 → 404', async () => {
    const { db } = fakeDb({ workspaceId: 'ws2' })
    vi.mocked(getDb).mockReturnValue(db)
    currentBody = { pinned: true }

    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 404 })
  })
})
