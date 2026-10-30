import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 草稿記住選好的時間、但**不排上**（`D-167`②，2026-10-30 老闆「好 執行」）。
 *
 * 以前「儲存草稿」把時間整個清掉：存完畫面跳回「立即發送」、按鈕變「驗證並發送」，
 * 2026-10-29 MYFEEL 三則都以為排好了，其實都是草稿、到時間不會送。
 * ⛔ 記著的時間放 `plannedScheduleAt`，不可以進 `scheduleAt`（那一格有值＝排上了，排程器會送）。
 */

const WS = 'ws1'
let caller: { role: string, isSuperAdmin: boolean } = { role: 'agent', isSuperAdmin: false }

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'u1', ...caller })),
}))
vi.mock('~~/server/utils/audit-log', () => ({
  writeAuditLog: vi.fn(async () => {}),
  auditTimeText: vi.fn(() => null),
  auditSnapshot: vi.fn(() => ({})),
  diffChangedFields: vi.fn(() => ({ changedKeys: [], before: {}, after: {} })),
}))
vi.mock('~~/server/utils/billing', () => ({ getWorkspacePlan: vi.fn(async () => null) }))
// 模擬「送出收到管理員」：記時間只是存草稿，沒有送出權限也要存得起來
vi.mock('~~/shared/permissions', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/shared/permissions')>()
  return {
    ...real,
    can: (role: any, cap: any) => (cap === 'broadcast.send' ? role === 'admin' || role === 'owner' : real.can(role, cap)),
  }
})

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'bc1')
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: putHandler } = await import('./[id].put')
const { getDb } = await import('~~/server/utils/firebase')

const FUTURE = new Date(Date.now() + 3 * 86400_000).toISOString()

function makeDb(current: Record<string, unknown>) {
  const update = vi.fn(async (_u: Record<string, unknown>) => {})
  vi.mocked(getDb).mockReturnValue({
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: vi.fn(async () => ({
          exists: true,
          data: () => ({ workspaceId: WS, name: '小滑手＿專案倒數推播', audienceSource: { type: 'all' }, messages: [{ type: 'text', text: 'hi' }], ...current }),
        })),
        update,
      })),
    })),
  } as any)
  return update
}

beforeEach(() => {
  caller = { role: 'agent', isSuperAdmin: false }
  body = {}
})

describe('PUT /api/broadcast/:id：草稿記住時間、但不排上', () => {
  it('🔴 草稿選了時間按「儲存草稿」→ 時間記在 plannedScheduleAt，⛔ 還是草稿、scheduleAt 是空的', async () => {
    const update = makeDb({ status: 'draft', scheduleAt: null })
    body = { name: '小滑手＿專案倒數推播', scheduleAt: null, plannedScheduleAt: FUTURE }
    await expect((putHandler as any)({})).resolves.toMatchObject({ status: 'draft', scheduleAt: null })
    const u = update.mock.calls[0]![0]
    expect(u.status).toBe('draft')
    expect(u.scheduleAt).toBeNull()
    expect(u.plannedScheduleAt).toBeInstanceOf(Date)
    expect((u.plannedScheduleAt as Date).toISOString()).toBe(FUTURE)
  })

  it('⛔ 只是記著，沒有送出權限的人（客服）照樣存得起來', async () => {
    const update = makeDb({ status: 'draft', scheduleAt: null })
    body = { scheduleAt: null, plannedScheduleAt: FUTURE }
    await expect((putHandler as any)({})).resolves.toMatchObject({ status: 'draft' })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('改回「立即發送」再存 → 記著的時間清掉', async () => {
    const update = makeDb({ status: 'draft', scheduleAt: null, plannedScheduleAt: new Date(FUTURE) })
    body = { scheduleAt: null, plannedScheduleAt: null }
    await (putHandler as any)({})
    expect(update.mock.calls[0]![0].plannedScheduleAt).toBeNull()
  })

  it('排程中的那一則存檔 → 只認 scheduleAt，舊的記著的時間清掉（⛔ 兩個時間對不起來）', async () => {
    caller = { role: 'admin', isSuperAdmin: false }
    const update = makeDb({ status: 'scheduled', scheduleAt: new Date(FUTURE), plannedScheduleAt: new Date(FUTURE) })
    body = { scheduleAt: FUTURE, plannedScheduleAt: FUTURE }
    await expect((putHandler as any)({})).resolves.toMatchObject({ status: 'scheduled' })
    expect(update.mock.calls[0]![0].plannedScheduleAt).toBeNull()
  })

  it('時間格式壞掉 → 400，⛔ 一個字都沒寫進去', async () => {
    const update = makeDb({ status: 'draft', scheduleAt: null })
    body = { scheduleAt: null, plannedScheduleAt: '下禮拜五' }
    await expect((putHandler as any)({})).rejects.toMatchObject({ statusCode: 400 })
    expect(update).not.toHaveBeenCalled()
  })

  it('對照組：沒帶 plannedScheduleAt（舊版畫面）→ 不動那一格', async () => {
    const update = makeDb({ status: 'draft', scheduleAt: null, plannedScheduleAt: new Date(FUTURE) })
    body = { name: '只改名字' }
    await (putHandler as any)({})
    expect('plannedScheduleAt' in update.mock.calls[0]![0]).toBe(false)
  })
})
