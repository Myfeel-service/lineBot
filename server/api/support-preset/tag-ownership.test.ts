import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 客服預存上的貼標只能是這個帳號自己的標籤（`G-98`，2026-09-29 權限盤點）。
 *
 * 存的當下就擋：留到客服按送出時才過濾，是靜靜少貼一顆、沒有人看得到。
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/audit-log', () => ({
  writeAuditLog: vi.fn(async () => {}),
  diffChangedFields: () => ({ before: {}, after: {}, changedKeys: [] }),
}))

let body: Record<string, unknown> = {}
const setSpy = vi.fn(async () => {})
const updateSpy = vi.fn(async () => {})
const DOCS: Record<string, Record<string, Record<string, unknown>>> = {
  tags: { mine: { workspaceId: WS, name: 'VIP' }, theirs: { workspaceId: 'ws2', name: '別家' } },
  supportPresets: { p1: { workspaceId: WS, name: '舊的', isActive: true, action: { type: 'message', text: 'hi' } } },
}
const db = {
  collection: (col: string) => ({
    doc: (id: string) => ({
      id,
      get: async () => ({ id, exists: !!DOCS[col]?.[id], data: () => DOCS[col]?.[id] }),
      set: setSpy,
      update: updateSpy,
    }),
  }),
  getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) => Promise.all(refs.map(r => r.get())),
}

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'p1')
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('getDb', () => db)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: createHandler } = await import('./create.post')
const { default: putHandler } = await import('./[id].put')

const presetBody = (addTagIds: string[]) => ({
  name: '出貨查詢',
  isActive: true,
  action: { type: 'message', text: '您的訂單已出貨' },
  tagging: { enabled: true, addTagIds },
})
const call = (h: unknown) => (h as (e: unknown) => Promise<unknown>)({})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('客服預存存檔時比對標籤歸屬', () => {
  it('新增：自家的標籤照存', async () => {
    body = presetBody(['mine'])
    await expect(call(createHandler)).resolves.toMatchObject({ name: '出貨查詢' })
    expect(setSpy).toHaveBeenCalledTimes(1)
  })

  it('🔴 新增：選了別家的標籤 → 400，一個字都不寫', async () => {
    body = presetBody(['mine', 'theirs'])
    await expect(call(createHandler)).rejects.toMatchObject({ statusCode: 400 })
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('🔴 修改：選了別家的（或不存在的）標籤 → 400，不更新', async () => {
    body = presetBody(['gone'])
    await expect(call(putHandler)).rejects.toMatchObject({ statusCode: 400 })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('修改：自家的標籤照存', async () => {
    body = presetBody(['mine'])
    await expect(call(putHandler)).resolves.toMatchObject({ id: 'p1' })
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })
})
