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
const getLineMessageQuota = vi.fn(async (): Promise<unknown> => ({ limit: 3000, used: 210, remaining: 2790 }))
const readLineMessageQuotaCached = vi.fn(async (): Promise<unknown> => ({ kind: 'ok', quota: { limit: 3000, used: 2500, remaining: 500 } }))
vi.mock('~~/server/utils/line', () => ({ getLineMessageQuota, readLineMessageQuotaCached }))

let query: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => query)

const { default: handler } = await import('./list.get')

beforeEach(() => {
  listDocs.mockClear()
  workspaceBroadcastTier.mockClear()
  getLineMessageQuota.mockClear()
  readLineMessageQuotaCached.mockClear()
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
    expect(getLineMessageQuota).not.toHaveBeenCalled()
  })
})

/**
 * `C-380`：推播頁左邊「LINE 這個月還剩約幾則」跟草稿總數、推播等級同一趟問（`withLineQuota=1`），不另開端點。
 */
describe('推播清單：順便回 LINE 這個月還剩幾則', () => {
  it('withPlan＋withLineQuota → 等級跟則數都回，問的是這個帳號', async () => {
    query = { status: 'draft', page: '1', limit: '1', withPlan: '1', withLineQuota: '1' }
    const r = await (handler as any)({})
    expect(r.broadcastTier).toBe('basic')
    expect(r.lineQuota).toEqual({ limit: 3000, used: 210, remaining: 2790 })
    expect(getLineMessageQuota).toHaveBeenCalledWith('ws1')
  })

  it('只帶 withLineQuota → 只回則數、不去問方案', async () => {
    query = { page: '1', limit: '1', withLineQuota: '1' }
    const r = await (handler as any)({})
    expect(r.lineQuota).toEqual({ limit: 3000, used: 210, remaining: 2790 })
    expect('broadcastTier' in r).toBe(false)
    expect(workspaceBroadcastTier).not.toHaveBeenCalled()
  })

  it('讀不到 → lineQuota 是 null、清單照常回', async () => {
    getLineMessageQuota.mockResolvedValueOnce(null)
    query = { page: '1', limit: '1', withPlan: '1', withLineQuota: '1' }
    const r = await (handler as any)({})
    expect(r.lineQuota).toBeNull()
    expect(r.items).toHaveLength(1)
  })

  it('`D-146` lineQuotaOnly=1 → 只回則數（走 5 分鐘快取），⛔ 推播清單一筆都沒讀、也不問方案', async () => {
    query = { lineQuotaOnly: '1' }
    const r = await (handler as any)({})
    expect(r).toEqual({ lineQuota: { limit: 3000, used: 2500, remaining: 500 } })
    expect(readLineMessageQuotaCached).toHaveBeenCalledWith('ws1')
    expect(listDocs).not.toHaveBeenCalled()
    expect(workspaceBroadcastTier).not.toHaveBeenCalled()
  })

  it('`D-146` lineQuotaOnly：沒接 LINE、問不到 → null（畫面不顯示）', async () => {
    query = { lineQuotaOnly: '1' }
    readLineMessageQuotaCached.mockResolvedValueOnce({ kind: 'unconfigured' })
    expect(await (handler as any)({})).toEqual({ lineQuota: null })
    readLineMessageQuotaCached.mockResolvedValueOnce({ kind: 'error', detail: 'x' })
    expect(await (handler as any)({})).toEqual({ lineQuota: null })
  })

  it('只帶 withPlan（舊的呼叫）→ 不去問 LINE、也沒有 lineQuota 這一格', async () => {
    query = { page: '1', limit: '1', withPlan: '1' }
    const r = await (handler as any)({})
    expect(r.broadcastTier).toBe('basic')
    expect('lineQuota' in r).toBe(false)
    expect(getLineMessageQuota).not.toHaveBeenCalled()
  })
})
