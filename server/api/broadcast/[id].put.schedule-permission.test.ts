import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 會讓推播排上時間的動作一律要「送出」權限（`C-352`②，2026-10-19 老闆「照建議」）。
 *
 * 以前「儲存變更」（`PUT /api/broadcast/:id`）只看「寫草稿」權限，帶排程時間就能把推播排上；
 * 正式的「確認排程」（`/schedule`）卻要「送出」權限——同一件事兩道門。
 *
 * ⚠️ 照**現在**的權限表，寫草稿與送出都是客服（agent）起跳，所以今天沒有任何人因此少一件事
 *    （`shared/broadcast-save-capability.test.ts` 釘著這件事）。這裡模擬的是「哪天把送出收到管理員」：
 *    那時候這一道門不收斂，客服就能繞過驗證視窗、自己把推播排上去。
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
// 模擬「送出收到管理員」：其餘能力照真的表
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

function makeDb(status: string) {
  const update = vi.fn(async () => {})
  vi.mocked(getDb).mockReturnValue({
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: vi.fn(async () => ({
          exists: true,
          data: () => ({ workspaceId: WS, status, name: '週末快閃', audienceSource: { type: 'all' }, messages: [{ type: 'text', text: 'hi' }] }),
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

describe('PUT /api/broadcast/:id：會讓推播排上時間的一律要送出權限', () => {
  it('🔴 草稿帶排程時間存檔（＝把它排上去）→ 沒有送出權限就 403，⛔ 一個字都沒寫進去', async () => {
    const update = makeDb('draft')
    body = { name: '改個名字', scheduleAt: FUTURE }
    await expect((putHandler as any)({})).rejects.toMatchObject({ statusCode: 403 })
    expect(update).not.toHaveBeenCalled()
  })

  it('🔴 已經排好的那一則：改內容、拿掉排程都一樣要送出權限（改的是到時間會自動送出去的東西）', async () => {
    let update = makeDb('scheduled')
    body = { messages: [{ type: 'text', text: '換一句' }], scheduleAt: FUTURE }
    await expect((putHandler as any)({})).rejects.toMatchObject({ statusCode: 403 })
    expect(update).not.toHaveBeenCalled()

    update = makeDb('scheduled')
    body = { scheduleAt: null }
    await expect((putHandler as any)({})).rejects.toMatchObject({ statusCode: 403 })
    expect(update).not.toHaveBeenCalled()
  })

  it('⛔ 存草稿不受影響：只有寫草稿權限照樣存得起來', async () => {
    const update = makeDb('draft')
    body = { name: '改個名字', scheduleAt: null }
    await expect((putHandler as any)({})).resolves.toMatchObject({ status: 'draft' })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('對照組：有送出權限的人（管理員）、平台超管照樣排得上（證明上面擋的是權限，不是別的）', async () => {
    caller = { role: 'admin', isSuperAdmin: false }
    let update = makeDb('draft')
    body = { scheduleAt: FUTURE }
    await expect((putHandler as any)({})).resolves.toMatchObject({ status: 'scheduled' })
    expect(update).toHaveBeenCalledTimes(1)

    caller = { role: 'agent', isSuperAdmin: true }
    update = makeDb('scheduled')
    body = { messages: [{ type: 'text', text: '換一句' }], scheduleAt: FUTURE }
    await expect((putHandler as any)({})).resolves.toMatchObject({ status: 'scheduled' })
    expect(update).toHaveBeenCalledTimes(1)
  })
})
