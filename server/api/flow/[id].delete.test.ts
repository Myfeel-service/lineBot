import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 刪模組端點的檢查順序（`D-110`）。
 *
 * ⛔ 釘的是「別家的東西一律 404」：原本先判斷系統模組、後判斷工作區，
 *    拿別家工作區的系統模組 id 來打會收到 403「系統模組不可刪除」，
 *    等於跟外人證實那個 id 存在、而且是系統模組。
 */

const WS = 'ws1'

vi.mock('~~/server/utils/firebase', () => ({ getDoc: vi.fn(), deleteDoc: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS, uid: 'u1', role: 'agent' })),
}))
vi.mock('~~/server/utils/broken-module-refs', () => ({ invalidateBrokenModuleRefsCache: vi.fn() }))
vi.mock('~~/server/utils/audit-log', () => ({
  writeAuditLog: vi.fn(async () => {}),
  auditSnapshot: vi.fn(() => ({})),
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'f1')
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(o.statusMessage ?? 'e'), o))

const { default: handler } = await import('./[id].delete')
const { getDoc, deleteDoc } = await import('~~/server/utils/firebase')

const run = () => (handler as (e: unknown) => Promise<unknown>)({})
/** getDoc 是泛型，端點自己帶型別；這裡只要餵它一份模組文件 */
const givenFlow = (doc: Record<string, unknown> | null) =>
  vi.mocked(getDoc).mockResolvedValue((doc ? { id: 'f1', ...doc } : null) as never)

beforeEach(() => {
  vi.mocked(getDoc).mockReset()
  vi.mocked(deleteDoc).mockClear()
})

describe('DELETE /api/flow/:id', () => {
  it('⛔ 別家工作區的系統模組：404，不是 403（不洩漏它存在）', async () => {
    givenFlow({ workspaceId: 'other-ws', isSystem: true, name: '真人客服' })
    await expect(run()).rejects.toMatchObject({ statusCode: 404 })
    expect(deleteDoc).not.toHaveBeenCalled()
  })

  it('不存在：404', async () => {
    givenFlow(null)
    await expect(run()).rejects.toMatchObject({ statusCode: 404 })
  })

  it('自己的系統模組：403，不刪', async () => {
    givenFlow({ workspaceId: WS, isSystem: true, name: '歡迎' })
    await expect(run()).rejects.toMatchObject({ statusCode: 403 })
    expect(deleteDoc).not.toHaveBeenCalled()
  })

  it('自己的一般模組：刪掉', async () => {
    givenFlow({ workspaceId: WS, name: '查詢訂單' })
    await expect(run()).resolves.toEqual({ success: true })
    expect(deleteDoc).toHaveBeenCalledWith('flows', 'f1')
  })
})
