import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 帳號層改角色／移除成員的護欄（`G-101`②③④，2026-09-29 權限盤點）。
 * 組織層早就擋「不能移除自己、不能移除最後一位管理員」，帳號層原本什麼都沒擋，
 * 改完、移完也不清權限快取；降成觀察者還照樣收 LINE 通知。
 */

const { store, caller } = vi.hoisted(() => ({
  store: {
    members: {} as Record<string, Record<string, unknown>>,
    /** 發生順序：notify＝從通知名單拿掉、update／delete＝寫成員文件、invalidate＝清快取 */
    events: [] as string[],
    notifyResult: 'removed' as 'removed' | 'absent' | 'failed',
    updates: [] as { id: string, patch: Record<string, unknown> }[],
    /** 交易開始前插一腳：模擬「交易外看的時候還有兩位管理員，交易時另一位已經被別人改掉」 */
    beforeTx: null as null | (() => void),
  },
  caller: { uid: 'me', workspaceId: 'w1', isSuperAdmin: false, isOrgAdmin: false },
}))

vi.mock('~~/server/utils/firebase', () => {
  const membersQuery = {
    get: async () => ({
      docs: Object.entries(store.members)
        .filter(([, d]) => d.workspaceId === caller.workspaceId)
        .map(([id, d]) => ({ id, data: () => d })),
    }),
  }
  return {
    getDb: () => ({
      collection: () => ({
        doc: (id: string) => ({ id }),
        where: () => membersQuery,
      }),
      runTransaction: async (fn: (tx: unknown) => unknown) => (store.beforeTx?.(), fn({
        get: (q: { get: () => unknown }) => q.get(),
        update: (ref: { id: string }, patch: Record<string, unknown>) => {
          store.events.push('update')
          store.updates.push({ id: ref.id, patch })
        },
        delete: (ref: { id: string }) => {
          store.events.push('delete')
          delete store.members[ref.id]
        },
      })),
    }),
  }
})
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ ...caller, role: 'admin' })),
  invalidateWorkspaceMemberCache: vi.fn(() => { store.events.push('invalidate') }),
}))
vi.mock('~~/server/utils/member-line-bind', () => ({
  removeFromHandoffNotify: vi.fn(async () => {
    store.events.push('notify')
    return store.notifyResult
  }),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: putHandler } = await import('./[uid].put')
const { default: deleteHandler } = await import('./[uid].delete')
const { invalidateWorkspaceMemberCache, requireCapability } = await import('~~/server/utils/workspace-auth')
const { removeFromHandoffNotify } = await import('~~/server/utils/member-line-bind')

const put = (targetUid: string, role: string) => {
  body = { role }
  return (putHandler as any)({ context: { params: { uid: targetUid } } })
}
const del = (targetUid: string) => (deleteHandler as any)({ context: { params: { uid: targetUid } } })

beforeEach(() => {
  caller.uid = 'me'
  caller.isSuperAdmin = false
  caller.isOrgAdmin = false
  store.members = {
    me_w1: { workspaceId: 'w1', uid: 'me', role: 'admin' },
    a2_w1: { workspaceId: 'w1', uid: 'a2', role: 'admin', lineUserId: 'Ua2' },
    ag_w1: { workspaceId: 'w1', uid: 'ag', role: 'agent', lineUserId: 'Uag' },
  }
  store.events = []
  store.notifyResult = 'removed'
  store.updates = []
  store.beforeTx = null
  vi.mocked(invalidateWorkspaceMemberCache).mockClear()
  vi.mocked(removeFromHandoffNotify).mockClear()
})

describe('PUT 改角色', () => {
  it('🔴 不能改自己（手滑改成觀察者會立刻被踢出設定頁）', async () => {
    await expect(put('me', 'viewer')).rejects.toMatchObject({ statusCode: 400, statusMessage: '不能改自己的角色。請由其他管理員操作' })
    expect(store.updates).toHaveLength(0)
  })

  it('超管不受「不能改自己」限制（他的權限不靠這筆成員文件）', async () => {
    caller.isSuperAdmin = true
    await put('me', 'agent')
    expect(store.updates).toEqual([{ id: 'me_w1', patch: { role: 'agent' } }])
  })

  it('🔴 不能把最後一位管理員改掉', async () => {
    store.members = {
      a2_w1: { workspaceId: 'w1', uid: 'a2', role: 'admin' },
      ag_w1: { workspaceId: 'w1', uid: 'ag', role: 'agent' },
    }
    await expect(put('a2', 'agent')).rejects.toMatchObject({ statusCode: 400 })
    expect(store.updates).toHaveLength(0)
    // ⛔ 被擋下來的不可以先把人從通知名單拿掉
    expect(store.events).toEqual([])
  })

  it('🔴 併發：交易時另一位管理員已被降級 → 交易裡再擋一次', async () => {
    store.beforeTx = () => { store.members.me_w1 = { ...store.members.me_w1, role: 'agent' } }
    await expect(put('a2', 'agent')).rejects.toMatchObject({ statusCode: 400 })
    expect(store.updates).toHaveLength(0)
  })

  it('還有另一位管理員 → 可以改；改完清權限快取', async () => {
    await put('a2', 'agent')
    expect(store.updates).toEqual([{ id: 'a2_w1', patch: { role: 'agent' } }])
    expect(invalidateWorkspaceMemberCache).toHaveBeenCalledWith('a2', 'w1')
    // 不是降成觀察者 → 不動通知名單
    expect(removeFromHandoffNotify).not.toHaveBeenCalled()
  })

  it('🔴 降成觀察者 → 先從通知名單拿掉、再改角色、再清快取', async () => {
    await put('ag', 'viewer')
    expect(removeFromHandoffNotify).toHaveBeenCalledWith('w1', 'Uag')
    expect(store.events).toEqual(['notify', 'update', 'invalidate'])
  })

  it('🔴 名單拿不掉 → 500，角色 ⛔ 不改（`C-271`⑥：反過來他會以觀察者身分繼續收客人的原話）', async () => {
    store.notifyResult = 'failed'
    await expect(put('ag', 'viewer')).rejects.toMatchObject({ statusCode: 500 })
    expect(store.updates).toHaveLength(0)
  })

  it('門檻讀權限表 members.manage（`G-106`）', async () => {
    await put('ag', 'agent')
    expect(requireCapability).toHaveBeenCalledWith(expect.anything(), 'members.manage')
  })

  it('🔴 帳號管理員改不了擁有者（`G-96`），訊息 ⛔ 不再叫人去不存在的「轉移所有權」', async () => {
    store.members.ow_w1 = { workspaceId: 'w1', uid: 'ow', role: 'owner' }
    await expect(put('ow', 'agent')).rejects.toMatchObject({ statusCode: 403, statusMessage: '擁有者的角色只有組織管理員能改' })
    expect(store.updates).toHaveLength(0)
  })

  it('⭐ 組織管理員／超管可以改擁有者（`G-96`）', async () => {
    store.members.ow_w1 = { workspaceId: 'w1', uid: 'ow', role: 'owner' }
    caller.isOrgAdmin = true
    await put('ow', 'agent')
    caller.isOrgAdmin = false
    caller.isSuperAdmin = true
    await put('ow', 'viewer')
    expect(store.updates.map(u => u.patch.role)).toEqual(['agent', 'viewer'])
  })

  it('🔴 誰都不能把人改成擁有者（連組織管理員也不行）', async () => {
    caller.isOrgAdmin = true
    await expect(put('ag', 'owner')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('🔴 擁有者是唯一一位管理級 → 組織管理員也不能把他降掉（擁有者算管理員人數）', async () => {
    store.members = {
      ow_w1: { workspaceId: 'w1', uid: 'ow', role: 'owner' },
      ag_w1: { workspaceId: 'w1', uid: 'ag', role: 'agent' },
    }
    caller.isOrgAdmin = true
    await expect(put('ow', 'agent')).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('DELETE 移除成員', () => {
  it('🔴 不能移除自己', async () => {
    await expect(del('me')).rejects.toMatchObject({ statusCode: 400, statusMessage: '不能移除自己。請由其他管理員操作' })
    expect(store.members.me_w1).toBeTruthy()
  })

  it('🔴 不能移除最後一位管理員（名單也 ⛔ 不先動）', async () => {
    store.members = {
      a2_w1: { workspaceId: 'w1', uid: 'a2', role: 'admin', lineUserId: 'Ua2' },
      ag_w1: { workspaceId: 'w1', uid: 'ag', role: 'agent' },
    }
    await expect(del('a2')).rejects.toMatchObject({ statusCode: 400, statusMessage: '不能移除最後一位管理員，帳號會沒有人能管理' })
    expect(store.members.a2_w1).toBeTruthy()
    expect(store.events).toEqual([])
  })

  it('🔴 併發：交易外看還有兩位管理員，交易時另一位已被移走 → 交易裡再擋一次（⛔ 不能只靠交易外那次）', async () => {
    store.beforeTx = () => { delete store.members.me_w1 }
    await expect(del('a2')).rejects.toMatchObject({ statusCode: 400 })
    expect(store.members.a2_w1).toBeTruthy()
  })

  it('⭐ 移除後清權限快取（原本被移除的人在同一台機器上還能再用 15 秒）', async () => {
    await del('ag')
    expect(store.members.ag_w1).toBeUndefined()
    expect(store.events).toEqual(['notify', 'delete', 'invalidate'])
    expect(invalidateWorkspaceMemberCache).toHaveBeenCalledWith('ag', 'w1')
  })

  it('找不到 → 404', async () => {
    await expect(del('nobody')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('🔴 帳號管理員移不掉擁有者；組織管理員可以（`G-96`）', async () => {
    store.members.ow_w1 = { workspaceId: 'w1', uid: 'ow', role: 'owner', lineUserId: 'Uow' }
    await expect(del('ow')).rejects.toMatchObject({ statusCode: 403, statusMessage: '擁有者只有組織管理員能移除' })
    expect(store.members.ow_w1).toBeTruthy()

    caller.isOrgAdmin = true
    await del('ow')
    expect(store.members.ow_w1).toBeUndefined()
    expect(removeFromHandoffNotify).toHaveBeenCalledWith('w1', 'Uow')
  })
})
