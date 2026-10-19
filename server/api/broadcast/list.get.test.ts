import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `GET /api/broadcast/list?planOnly=1`（`C-352`①）：好友頁、好友統計、首頁檔期卡、活動精靈要在入口先講方案限制，
 * 只需要推播等級。⛔ 不可以為了一個等級把整個推播集合讀一遍（讀取費，`E-38`）；⛔ 只回等級、不回方案名（`G-103`）。
 */

const listDocs = vi.fn(async () => [
  { id: 'b1', status: 'draft', name: 'x', audienceSnapshot: { estimatedCount: 0 }, messages: [] },
])
vi.mock('~~/server/utils/firebase', () => ({ listDocs }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: 'ws1', uid: 'u1', role: 'agent' })),
}))
const workspaceBroadcastTier = vi.fn(async () => 'basic')
vi.mock('~~/server/utils/broadcast-plan-gate', () => ({ workspaceBroadcastTier }))

let query: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => query)

const { default: handler } = await import('./list.get')

beforeEach(() => {
  listDocs.mockClear()
  workspaceBroadcastTier.mockClear()
  query = {}
})

describe('推播清單：只問等級', () => {
  it('planOnly=1 → 只回等級，⛔ 推播清單一筆都沒讀', async () => {
    query = { planOnly: '1' }
    const r = await (handler as any)({})
    expect(r).toEqual({ broadcastTier: 'basic' })
    expect(listDocs).not.toHaveBeenCalled()
  })

  it('對照組：沒帶 planOnly 照舊回清單、不問方案', async () => {
    const r = await (handler as any)({})
    expect(Array.isArray(r) ? r : r.items).toHaveLength(1)
    expect(workspaceBroadcastTier).not.toHaveBeenCalled()
  })
})
