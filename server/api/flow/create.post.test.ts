import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 建立模組帶 `insertBeforeId`（複製模組用）：新模組放在原模組正上方、跟它同一個資料夾。
 *
 * 以前複製出來的一律排在整份清單最上面、不在任何資料夾，模組一多就要捲到頂再一路拖回去。
 * ⛔ 沒帶、或對不到這個工作區的自建模組時，行為跟以前一樣（排最上面、不進資料夾）。
 */

const WS = 'ws1'

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn(), listDocs: vi.fn(), createDoc: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'u1', role: 'admin' })),
}))
vi.mock('~~/server/utils/billing', () => ({ assertPlanAllows: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/broken-module-refs', () => ({ invalidateBrokenModuleRefsCache: vi.fn() }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

let currentBody: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => currentBody)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(o.statusMessage ?? 'e'), o))

const { default: handler } = await import('./create.post')
const { getDb, listDocs, createDoc } = await import('~~/server/utils/firebase')

const at = (ms: number) => ({ toMillis: () => ms })
const flow = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, workspaceId: WS, name: id, createdAt: at(1), ...extra })

/** 這個工作區現有的模組：一個系統模組、上面兩個未分類、「活動」資料夾裡兩個 */
const EXISTING = [
  flow(`${WS}_live_agent`, { isSystem: true, moduleType: 'live_agent' }),
  flow('top', { sortOrder: 0 }),
  flow('second', { sortOrder: 1 }),
  flow('promo-a', { sortOrder: 2, folderId: 'folder-promo' }),
  flow('promo-b', { sortOrder: 3, folderId: 'folder-promo' }),
]

let committed: Array<{ id: string, data: Record<string, unknown> }> = []
function stubDb() {
  committed = []
  vi.mocked(listDocs).mockResolvedValue(EXISTING as never)
  vi.mocked(createDoc).mockImplementation((async (_c: string, id: string, data: object) => ({ id, ...data })) as never)
  vi.mocked(getDb).mockReturnValue({
    collection: () => ({ doc: (id: string) => ({ id }) }),
    batch: () => {
      const pending: typeof committed = []
      return {
        update: (ref: { id: string }, data: Record<string, unknown>) => { pending.push({ id: ref.id, data }) },
        commit: async () => { committed.push(...pending) },
      }
    },
  } as never)
}

const run = (body: Record<string, unknown>) => {
  currentBody = { name: '複製的', messages: [{ type: 'text', text: '嗨' }], isActive: true, ...body }
  return (handler as (e: unknown) => Promise<Record<string, unknown>>)({})
}
const createdData = () => vi.mocked(createDoc).mock.calls[0]![2] as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  stubDb()
})

describe('POST /api/flow/create：insertBeforeId（複製模組）', () => {
  it('複製資料夾裡的模組：新的跟它同一個資料夾、排在它正上方', async () => {
    await run({ insertBeforeId: 'promo-b' })
    expect(createdData()).toMatchObject({ folderId: 'folder-promo', sortOrder: 3 })
    // 只挪原模組（3→4），上面的不動
    expect(committed).toEqual([{ id: 'promo-b', data: { sortOrder: 4 } }])
  })

  it('複製未分類的模組：新的也是未分類（不帶 folderId）、排在它正上方', async () => {
    await run({ insertBeforeId: 'second' })
    expect(createdData()).toMatchObject({ sortOrder: 1 })
    expect(createdData()).not.toHaveProperty('folderId')
    expect(committed.map(c => [c.id, c.data.sortOrder])).toEqual([['second', 2], ['promo-a', 3], ['promo-b', 4]])
  })

  it('沒帶 insertBeforeId：跟以前一樣排最上面、不進資料夾、不挪別人', async () => {
    await run({})
    expect(createdData()).toMatchObject({ sortOrder: -1 })
    expect(createdData()).not.toHaveProperty('folderId')
    expect(committed).toEqual([])
  })

  it('⛔ 對不到這個工作區的自建模組（系統模組／別家的／剛刪掉的）：照舊排最上面，不挪任何人', async () => {
    for (const insertBeforeId of [`${WS}_live_agent`, 'other-ws-flow', 42]) {
      vi.mocked(createDoc).mockClear()
      await run({ insertBeforeId })
      expect(createdData()).toMatchObject({ sortOrder: -1 })
      expect(createdData()).not.toHaveProperty('folderId')
    }
    expect(committed).toEqual([])
  })

  it('只在這個工作區裡找（查詢條件帶 workspaceId）', async () => {
    const wheres: unknown[][] = []
    vi.mocked(listDocs).mockImplementation((async (_c: string, q?: (ref: unknown) => unknown) => {
      const ref: any = { where: (...a: unknown[]) => { wheres.push(a); return ref } }
      q?.(ref)
      return EXISTING
    }) as never)
    await run({ insertBeforeId: 'promo-b' })
    expect(wheres).toContainEqual(['workspaceId', '==', WS])
  })
})
