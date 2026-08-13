import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「重設為草稿再發一次」的三個承諾：
 *   ① 只有失敗的單能重設——擋住把「已完成」的推播重發一次（就是重複轟炸整份名單）
 *   ② 別的官方帳號的推播動不到（多租戶）
 *   ③ 舊帳（沒收到的名單、追蹤連結點擊）要在改狀態**之前**清掉：
 *      清理是好幾趟批次刪除，中途掛掉在所難免；狀態要是先翻成草稿，這支就再也進不來
 *      （只收 failed），舊帳會混進下一次的成效報表。
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ts__',
    increment: (n: number) => ({ __increment: n }),
  },
}))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS })),
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'bc1')
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./retry.post')
const { getDb } = await import('~~/server/utils/firebase')
const mockGetDb = vi.mocked(getDb)

/** 依序記下發生過的事，用來驗「清舊帳」發生在「改狀態」之前 */
type Step = { kind: 'delete-deliveries' | 'delete-clicklogs' | 'update', patch?: Record<string, any> }

function makeDb(opts: {
  doc: Record<string, any> | null
  deliveries?: number
  clickLogs?: number
  failDeleteAt?: 'deliveries' | 'clicklogs'
}) {
  const steps: Step[] = []
  let deliveriesLeft = opts.deliveries ?? 0
  let clickLogsLeft = opts.clickLogs ?? 0

  const pageOf = (kind: 'delete-deliveries' | 'delete-clicklogs', left: number) => {
    const size = Math.min(left, 400)
    return {
      empty: size === 0,
      size,
      docs: Array.from({ length: size }, () => ({ ref: { __kind: kind } })),
    }
  }

  const deliveriesQuery: any = {
    limit: () => deliveriesQuery,
    get: async () => pageOf('delete-deliveries', deliveriesLeft),
  }
  const clickLogsQuery: any = {
    where: () => clickLogsQuery,
    limit: () => clickLogsQuery,
    get: async () => pageOf('delete-clicklogs', clickLogsLeft),
  }

  const ref = {
    get: async () => ({ exists: opts.doc !== null, data: () => opts.doc }),
    collection: () => deliveriesQuery,
  }

  const db = {
    collection: (name: string) => (name === 'broadcastClickLogs'
      ? clickLogsQuery
      : { doc: () => ref }),
    batch: () => {
      const pending: Array<'delete-deliveries' | 'delete-clicklogs'> = []
      return {
        delete: (r: any) => { pending.push(r.__kind) },
        commit: async () => {
          const kind = pending[0]!
          if (opts.failDeleteAt === 'deliveries' && kind === 'delete-deliveries') throw new Error('commit-boom')
          if (opts.failDeleteAt === 'clicklogs' && kind === 'delete-clicklogs') throw new Error('commit-boom')
          steps.push({ kind })
          if (kind === 'delete-deliveries') deliveriesLeft -= pending.length
          else clickLogsLeft -= pending.length
        },
      }
    },
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
      get: async () => ({ exists: opts.doc !== null, data: () => opts.doc }),
      update: (_r: any, patch: Record<string, any>) => { steps.push({ kind: 'update', patch }) },
    }),
  }

  mockGetDb.mockReturnValue(db as any)
  return { steps }
}

const failedDoc = { workspaceId: WS, status: 'failed', name: 'AROMIC預熱' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/broadcast/:id/retry', () => {
  it('失敗的單 → 重設回草稿、統計歸零、retryCount +1', async () => {
    const { steps } = makeDb({ doc: failedDoc })

    const res = await (handler as any)({})

    expect(res).toEqual({ success: true, id: 'bc1' })
    const update = steps.find(s => s.kind === 'update')!
    expect(update.patch!.status).toBe('draft')
    expect(update.patch!.sentCount).toBe(0)
    expect(update.patch!.failureReason).toBeNull()
    expect(update.patch!['audienceSnapshot.estimatedCount']).toBe(0)
    expect(update.patch!.retryCount).toEqual({ __increment: 1 })
  })

  it('已完成的單不可重設（會重複轟炸）→ 409，且一筆舊資料都不准動', async () => {
    const { steps } = makeDb({ doc: { workspaceId: WS, status: 'completed' }, deliveries: 10 })

    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 409 })
    expect(steps).toHaveLength(0)
  })

  it('發送中的單不可重設（先等看門狗）→ 409', async () => {
    makeDb({ doc: { workspaceId: WS, status: 'processing' } })
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 409 })
  })

  it('別的官方帳號的推播 → 404，且不准刪它的資料', async () => {
    const { steps } = makeDb({ doc: { workspaceId: 'other-ws', status: 'failed' }, deliveries: 10 })

    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 404 })
    expect(steps).toHaveLength(0)
  })

  it('找不到單 → 404', async () => {
    makeDb({ doc: null })
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 404 })
  })

  it('舊帳（失敗名單、點擊紀錄）一定在改狀態之前清掉，且會分批清完', async () => {
    // 900 筆失敗名單＝3 趟（400+400+100）；點擊 500 筆＝2 趟
    const { steps } = makeDb({ doc: failedDoc, deliveries: 900, clickLogs: 500 })

    await (handler as any)({})

    const kinds = steps.map(s => s.kind)
    expect(kinds.filter(k => k === 'delete-deliveries')).toHaveLength(3)
    expect(kinds.filter(k => k === 'delete-clicklogs')).toHaveLength(2)
    expect(kinds.indexOf('update')).toBe(kinds.length - 1)
  })

  it('清舊帳中途掛掉 → 狀態不可以已經被翻成草稿（再按一次就能從頭做完）', async () => {
    const { steps } = makeDb({ doc: failedDoc, deliveries: 10, failDeleteAt: 'deliveries' })

    await expect((handler as any)({})).rejects.toThrow('commit-boom')
    expect(steps.find(s => s.kind === 'update')).toBeUndefined()
  })
})
