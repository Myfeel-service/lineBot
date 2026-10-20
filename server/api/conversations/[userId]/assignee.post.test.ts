import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 指派負責人員的端點（`G-27`②）＋指派通知（`H-16`）：交給別人才用 LINE 告訴他，
 * 沒換人不傳、通知失敗不能讓指派失敗。通知本身的規則（指給自己、沒綁、收通知關著、節流）見 assign-notify.test.ts。
 */

const WS = 'ws1'
const CUSTOMER = 'U00000000000000000000000000000c01'

vi.mock('~~/server/utils/firebase', () => ({
  getDb: vi.fn(),
  getFirebaseAuth: () => ({ getUser: async (uid: string) => ({ displayName: uid === 'uid-amei' ? '阿美' : '', email: `${uid}@x.test` }) }),
}))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'uid-boss', token: { name: '老闆' } })),
}))
vi.mock('~~/server/utils/assign-notify', () => ({ notifyAssignee: vi.fn(async () => 'sent') }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => `${WS}_${CUSTOMER}`)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./assignee.post')
const { getDb } = await import('~~/server/utils/firebase')
const { notifyAssignee } = await import('~~/server/utils/assign-notify')

const MEMBERS = [
  { workspaceId: WS, uid: 'uid-amei', role: 'agent', invitedEmail: 'amei@x.test', lineUserId: 'U000000000000000000000000000amei1' },
  { workspaceId: WS, uid: 'uid-boss', role: 'owner', invitedEmail: 'boss@x.test' },
]

let conv: Record<string, unknown> = {}
const updates: Record<string, unknown>[] = []

beforeEach(() => {
  vi.clearAllMocks()
  updates.length = 0
  conv = { workspaceId: WS }
  vi.mocked(getDb).mockReturnValue({
    collection: (col: string) => ({
      doc: () => ({
        get: async () => ({ exists: col === 'conversations', data: () => conv }),
        update: async (patch: Record<string, unknown>) => { updates.push(patch); Object.assign(conv, patch) },
      }),
      where: (_f: string, _op: string, _v: unknown) => ({
        where: (_f2: string, _op2: string, uid: string) => ({
          limit: () => ({
            get: async () => ({ docs: MEMBERS.filter(m => m.uid === uid).map(m => ({ data: () => m })) }),
          }),
        }),
      }),
    }),
  } as never)
})

const call = () => (handler as unknown as (e: unknown) => Promise<any>)({})

describe('POST /api/conversations/:userId/assignee — 指派通知', () => {
  it('交給別人 → 指派寫進去，並用 LINE 告訴他（誰交的、哪位客人、他綁的那支手機）', async () => {
    body = { uid: 'uid-amei' }

    await expect(call()).resolves.toMatchObject({ uid: 'uid-amei', name: '阿美' })

    expect(updates[0]).toMatchObject({ assigneeUid: 'uid-amei', assigneeName: '阿美' })
    expect(vi.mocked(notifyAssignee)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyAssignee).mock.calls[0]![0]).toMatchObject({
      workspaceId: WS,
      assigneeUid: 'uid-amei',
      assigneeLineUserId: 'U000000000000000000000000000amei1',
      assignerUid: 'uid-boss',
      assignerName: '老闆',
      customerLineUserId: CUSTOMER,
    })
  })

  it('又選了同一位（沒換人）→ 不再傳一次', async () => {
    conv = { workspaceId: WS, assigneeUid: 'uid-amei' }
    body = { uid: 'uid-amei' }

    await call()

    expect(vi.mocked(notifyAssignee)).not.toHaveBeenCalled()
  })

  it('取消指派 → 不傳', async () => {
    conv = { workspaceId: WS, assigneeUid: 'uid-amei' }
    body = { uid: '' }

    await call()

    expect(vi.mocked(notifyAssignee)).not.toHaveBeenCalled()
  })

  it('通知沒送出去 → 指派照樣成功（指派是主要的事）', async () => {
    vi.mocked(notifyAssignee).mockResolvedValueOnce('failed')
    body = { uid: 'uid-amei' }

    await expect(call()).resolves.toMatchObject({ uid: 'uid-amei' })
    expect(updates[0]).toMatchObject({ assigneeUid: 'uid-amei' })
  })

  /**
   * 回給畫面「這次有沒有真的用 LINE 告訴他」：提示才講得出「也用 LINE 通知他了」。
   * ⛔ 只有真的送到（sent）才是 true——沒綁、收通知關著、指給自己、節流、送失敗都不能講成有通知。
   */
  it('LINE 真的送到 → lineNotified: true', async () => {
    body = { uid: 'uid-amei' }
    await expect(call()).resolves.toMatchObject({ uid: 'uid-amei', name: '阿美', lineNotified: true })
  })

  it.each(['not-bound', 'not-receiving', 'self', 'throttled', 'failed'] as const)('通知結果是 %s → lineNotified: false', async (result) => {
    vi.mocked(notifyAssignee).mockResolvedValueOnce(result)
    body = { uid: 'uid-amei' }
    await expect(call()).resolves.toMatchObject({ uid: 'uid-amei', lineNotified: false })
  })

  it('沒換人（沒去通知）、取消指派 → lineNotified: false', async () => {
    conv = { workspaceId: WS, assigneeUid: 'uid-amei' }
    body = { uid: 'uid-amei' }
    await expect(call()).resolves.toMatchObject({ lineNotified: false })

    body = { uid: '' }
    await expect(call()).resolves.toMatchObject({ uid: '', lineNotified: false })
  })
})
