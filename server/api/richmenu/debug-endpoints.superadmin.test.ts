import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 圖文選單的兩支除錯／一次性維護端點只給超管（`G-105`）。
 *
 * 用**真的** `workspace-auth` 跑（只假造 Firebase）：釘的是「一位貨真價實的客服打得進去自己
 * 的帳號、但打不進這兩支」。只 mock 守衛的話，換回 `requireWorkspaceAccess(event, 'agent')`
 * 測試照樣綠，等於沒測。
 */

let isSuper = false
const collectionsTouched: string[] = []
vi.mock('~~/server/utils/firebase', () => ({
  getFirebaseAuth: () => ({
    verifyIdToken: async () => ({ uid: 'u1', email: 'agent@example.com', ...(isSuper ? { superAdmin: true } : {}) }),
  }),
  getDb: () => ({
    collection: (name: string) => {
      collectionsTouched.push(name)
      return {
        // workspaceMembers/{uid}_{ws}：這位是 ws1 的客服
        doc: (id: string) => ({
          get: async () => name === 'workspaceMembers' && id === 'u1_ws1'
            ? { exists: true, data: () => ({ role: 'agent' }) }
            : { exists: name === 'workspaces', data: () => ({ organizationId: null }) },
        }),
        where: () => ({
          where: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
          get: async () => ({ docs: [{ id: 'm1', data: () => ({ name: '主選單', richMenuId: 'rich-1' }) }] }),
        }),
      }
    },
  }),
}))
vi.mock('~~/server/utils/line-workspace-credentials', () => ({
  getLineWorkspaceCredentials: vi.fn(async () => ({ channelAccessToken: 'tok' })),
}))

let query: Record<string, string> = {}
let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))
vi.stubGlobal('getHeader', () => 'Bearer t')
vi.stubGlobal('getQuery', () => query)
vi.stubGlobal('readBody', async () => body)
const getRichMenuAlias = vi.fn(async () => ({ richMenuId: 'rich-1' }))
vi.stubGlobal('getRichMenuAlias', getRichMenuAlias)
const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
vi.stubGlobal('fetch', fetchSpy)
vi.stubGlobal('updateDoc', vi.fn(async () => {}))

const { default: debugAliases } = await import('./debug-aliases.get')
const { default: migrateAliases } = await import('./migrate-aliases.post')
const call = (h: unknown) => (h as (e: unknown) => Promise<unknown>)({ context: {} })

beforeEach(() => {
  isSuper = false
  collectionsTouched.length = 0
  getRichMenuAlias.mockClear()
  fetchSpy.mockClear()
  query = { workspaceId: 'ws1' }
  body = { workspaceId: 'ws1' }
})

describe('richmenu 除錯端點只給超管', () => {
  it('⛔ 該帳號的客服打不進去：403，而且一張選單都沒讀、LINE 一次都沒打', async () => {
    await expect(call(debugAliases)).rejects.toMatchObject({ statusCode: 403 })
    await expect(call(migrateAliases)).rejects.toMatchObject({ statusCode: 403 })
    expect(collectionsTouched).not.toContain('richmenus')
    expect(getRichMenuAlias).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('超管沒帶 workspaceId → 400（⛔ 不可以變成全站範圍）', async () => {
    isSuper = true
    query = {}
    body = {}
    await expect(call(debugAliases)).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(migrateAliases)).rejects.toMatchObject({ statusCode: 400 })
    expect(collectionsTouched).not.toContain('richmenus')
  })

  it('超管帶了 workspaceId 照舊能用', async () => {
    isSuper = true
    await expect(call(debugAliases)).resolves.toEqual([
      expect.objectContaining({ firestoreId: 'm1', richMenuId: 'rich-1', lineAlias: { richMenuId: 'rich-1' } }),
    ])
    await expect(call(migrateAliases)).resolves.toMatchObject({ total: 1 })
  })
})
