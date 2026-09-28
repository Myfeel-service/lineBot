import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 貼標／拆標端點的帳號邊界與「誰做的」（2026-09-29 權限盤點 `G-98`、`G-107`）。
 *
 * 釘住的三件事：
 * ① 🔴 別家的標籤 id 貼不上自家客人（單人貼、批次貼都一樣），讀的時候也不顯示別家標籤的名字
 * ② 標籤流水（tagLogs）記下是誰貼／誰拆的——之前一律 `operatorId: null`，拆標改了推播對象卻查不到人
 * ③ 批次貼／拆寫一筆**摘要式**稽核（人數＋標籤名，不塞整份名單）
 */

const WS = 'ws1'
const UID = 'staff-1'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
}))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS, uid: UID })),
}))
vi.mock('~~/server/utils/ai-tag-suggest', () => ({
  prunePendingForAppliedTags: vi.fn(async () => {}),
  recordManualRemovalAsDismissed: vi.fn(async () => {}),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

let params: Record<string, string> = {}
let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', (_e: unknown, name: string) => params[name])
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { getDb } = await import('~~/server/utils/firebase')
const { writeAuditLog } = await import('~~/server/utils/audit-log')
const { default: tagsPost } = await import('../users/[id]/tags.post')
const { default: tagsGet } = await import('../users/[id]/tags.get')
const { default: tagDelete } = await import('../users/[id]/tags/[tagId].delete')
const { default: batchAdd } = await import('./batch-add.post')
const { default: batchRemove } = await import('./batch-remove.post')

type Store = Record<string, Record<string, Record<string, unknown>>>
interface Write { op: 'set' | 'delete', col: string, id: string, data?: any }

/** 迷你假 Firestore：主鍵讀、getAll、兩個 where 的查詢、batch；寫入全部記下來 */
function fakeDb(store: Store) {
  const writes: Write[] = []
  const ref = (col: string, id: string) => ({
    __col: col,
    id,
    get: async () => ({ id, exists: store[col]?.[id] != null, data: () => store[col]?.[id] }),
  })
  const query = (col: string, filters: Array<[string, unknown]>) => ({
    where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]]),
    get: async () => {
      const docs = Object.entries(store[col] ?? {})
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => ({ id, data: () => d }))
      return { docs, empty: docs.length === 0, size: docs.length }
    },
  })
  const db: any = {
    collection: (col: string) => ({
      doc: (id: string) => ref(col, id),
      where: (f: string, _op: string, v: unknown) => query(col, [[f, v]]),
    }),
    getAll: async (...refs: Array<ReturnType<typeof ref>>) => Promise.all(refs.map(r => r.get())),
    batch: () => ({
      set: (r: ReturnType<typeof ref>, data: any) => { writes.push({ op: 'set', col: r.__col, id: r.id, data }) },
      delete: (r: ReturnType<typeof ref>) => { writes.push({ op: 'delete', col: r.__col, id: r.id }) },
      commit: async () => {},
    }),
  }
  return { db, writes }
}

const USER_DOC = `${WS}_U1`
function baseStore(): Store {
  return {
    users: { [USER_DOC]: { workspaceId: WS } },
    tags: {
      mine: { workspaceId: WS, name: 'VIP', color: '#f00' },
      theirs: { workspaceId: 'ws2', name: '別家的機密分類', color: '#0f0' },
    },
    userTags: {},
  }
}

const call = (h: unknown) => (h as (e: unknown) => Promise<any>)({})

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { clearTagOwnerCache } = await import('~~/server/utils/workspace-tag-ids')
  clearTagOwnerCache()
})

describe('POST /api/users/:id/tags（單人貼標）', () => {
  it('🔴 混了一顆別家的 → 只貼自家的，回報 dropped；流水記下是誰貼的', async () => {
    const { db, writes } = fakeDb(baseStore())
    vi.mocked(getDb).mockReturnValue(db)
    params = { id: 'U1' }
    body = { tagIds: ['mine', 'theirs'] }

    const res = await call(tagsPost)
    expect(res.added).toEqual(['mine'])
    expect(res.dropped).toEqual(['theirs'])
    expect(writes.some(w => w.data?.tagId === 'theirs')).toBe(false)
    const log = writes.find(w => w.col === 'tagLogs')!
    expect(log.data).toMatchObject({ action: 'add', tagId: 'mine', operatorId: UID })
    expect(writes.find(w => w.col === 'userTags')!.data.createdBy).toBe(UID)
  })

  it('🔴 全部都是別家的 → 404，一個字都不寫（不回「成功、貼了 0 顆」）', async () => {
    const { db, writes } = fakeDb(baseStore())
    vi.mocked(getDb).mockReturnValue(db)
    params = { id: 'U1' }
    body = { tagIds: ['theirs'] }

    await expect(call(tagsPost)).rejects.toMatchObject({ statusCode: 404 })
    expect(writes).toHaveLength(0)
  })
})

describe('GET /api/users/:id/tags', () => {
  it('🔴 客人身上掛著別家的標籤 → 名字、顏色不讀出來', async () => {
    const store = baseStore()
    store.userTags = {
      [`${USER_DOC}_mine`]: { userId: USER_DOC, workspaceId: WS, tagId: 'mine' },
      [`${USER_DOC}_theirs`]: { userId: USER_DOC, workspaceId: WS, tagId: 'theirs' },
    }
    const { db } = fakeDb(store)
    vi.mocked(getDb).mockReturnValue(db)
    params = { id: 'U1' }

    const res = await call(tagsGet)
    expect(res.tags.find((t: any) => t.tagId === 'mine').name).toBe('VIP')
    expect(res.tags.find((t: any) => t.tagId === 'theirs')).toMatchObject({ name: '', color: '' })
    expect(JSON.stringify(res)).not.toContain('別家的機密分類')
  })
})

describe('DELETE /api/users/:id/tags/:tagId', () => {
  it('流水記下是誰拆的', async () => {
    const store = baseStore()
    store.userTags = { [`${USER_DOC}_mine`]: { userId: USER_DOC, workspaceId: WS, tagId: 'mine' } }
    const { db, writes } = fakeDb(store)
    vi.mocked(getDb).mockReturnValue(db)
    params = { id: 'U1', tagId: 'mine' }

    await call(tagDelete)
    expect(writes.find(w => w.col === 'tagLogs')!.data).toMatchObject({ action: 'remove', operatorId: UID })
  })
})

describe('POST /api/user-tags/batch-add', () => {
  it('🔴 別家的標籤不貼；流水記操作者；寫一筆摘要式稽核（人數＋標籤名，不塞名單）', async () => {
    const { db, writes } = fakeDb(baseStore())
    vi.mocked(getDb).mockReturnValue(db)
    body = { userIds: ['U1', 'U2', 'U3'], tagIds: ['mine', 'theirs'] }

    const res = await call(batchAdd)
    expect(res).toMatchObject({ total: 3, added: 3, skipped: 0, dropped: ['theirs'] })
    expect(writes.some(w => w.data?.tagId === 'theirs')).toBe(false)
    expect(writes.filter(w => w.col === 'tagLogs').every(w => w.data.operatorId === UID)).toBe(true)

    expect(writeAuditLog).toHaveBeenCalledTimes(1)
    const audit = vi.mocked(writeAuditLog).mock.calls[0]![0]
    expect(audit).toMatchObject({
      workspaceId: WS,
      uid: UID,
      action: 'userTags.batchAdd',
      after: { name: '「VIP」', tagIdsCount: 1, usersCount: 3, addedCount: 3, skippedCount: 0 },
    })
    // ⛔ 摘要式：名單不進稽核（一長就被截斷、整筆變 lossy）
    expect(JSON.stringify(audit)).not.toContain('U2')
    // ⛔ 別家標籤的名字也不能跑進自家的紀錄
    expect(JSON.stringify(audit)).not.toContain('別家的機密分類')
  })

  it('全部都已經有了 → 不寫稽核（沒動到就不留噪音）', async () => {
    const store = baseStore()
    store.userTags = { [`${USER_DOC}_mine`]: { userId: USER_DOC, workspaceId: WS, tagId: 'mine' } }
    const { db } = fakeDb(store)
    vi.mocked(getDb).mockReturnValue(db)
    body = { userIds: ['U1'], tagIds: ['mine'] }

    expect(await call(batchAdd)).toMatchObject({ added: 0, skipped: 1 })
    expect(writeAuditLog).not.toHaveBeenCalled()
  })

  it('🔴 全部都是別家的 → 404', async () => {
    const { db, writes } = fakeDb(baseStore())
    vi.mocked(getDb).mockReturnValue(db)
    body = { userIds: ['U1'], tagIds: ['theirs', 'gone'] }
    await expect(call(batchAdd)).rejects.toMatchObject({ statusCode: 404 })
    expect(writes).toHaveLength(0)
  })
})

describe('POST /api/user-tags/batch-remove', () => {
  it('流水記操作者＋一筆摘要式稽核', async () => {
    const store = baseStore()
    store.userTags = {
      [`${WS}_U1_mine`]: { userId: `${WS}_U1`, workspaceId: WS, tagId: 'mine' },
      [`${WS}_U2_mine`]: { userId: `${WS}_U2`, workspaceId: WS, tagId: 'mine' },
    }
    const { db, writes } = fakeDb(store)
    vi.mocked(getDb).mockReturnValue(db)
    body = { userIds: ['U1', 'U2', 'U3'], tagIds: ['mine'] }

    const res = await call(batchRemove)
    expect(res).toMatchObject({ removed: 2, notFound: 1 })
    expect(writes.filter(w => w.col === 'tagLogs').map(w => w.data.operatorId)).toEqual([UID, UID])
    expect(vi.mocked(writeAuditLog).mock.calls[0]![0]).toMatchObject({
      action: 'userTags.batchRemove',
      uid: UID,
      after: { name: '「VIP」', usersCount: 3, removedCount: 2, notFoundCount: 1 },
    })
  })

  it('⚠️ 修好之前被貼上的別家標籤，自家客人身上照樣拆得掉（拆標不過濾歸屬）', async () => {
    const store = baseStore()
    store.userTags = { [`${WS}_U1_theirs`]: { userId: `${WS}_U1`, workspaceId: WS, tagId: 'theirs' } }
    const { db, writes } = fakeDb(store)
    vi.mocked(getDb).mockReturnValue(db)
    body = { userIds: ['U1'], tagIds: ['theirs'] }

    expect(await call(batchRemove)).toMatchObject({ removed: 1 })
    expect(writes.some(w => w.op === 'delete' && w.id === `${WS}_U1_theirs`)).toBe(true)
    // 紀錄裡寫 id、⛔ 不寫別家標籤的名字
    expect(JSON.stringify(vi.mocked(writeAuditLog).mock.calls[0]![0])).not.toContain('別家的機密分類')
  })
})
