import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
  Timestamp: { now: () => ({ toMillis: () => Date.now() }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./broadcast-send', () => ({ executeBroadcastSend: vi.fn() }))

import { runDueScheduledBroadcasts } from './run-due-scheduled-broadcasts'
import { getDb } from './firebase'
import { executeBroadcastSend } from './broadcast-send'

const mockGetDb = vi.mocked(getDb)
const mockSend = vi.mocked(executeBroadcastSend)

const MIN = 60_000
/** 固定基準時刻：startedAt / updatedAt 要能精準比大小，不能各自 Date.now() */
const NOW = Date.now()
const ts = (msAgo: number) => ({ toMillis: () => NOW - msAgo })

type FakeDoc = { id: string; data: Record<string, any> }

/**
 * 假 Firestore：只認 status 等值條件——processing 回卡單、scheduled 回到期單，
 * scheduleAt '>' 的除錯查詢一律回空。runTransaction 的 tx.get 讀「當下」的 doc.data
 * （測試可在查詢後改 data 模擬競態）。
 */
function makeDb(processingDocs: FakeDoc[], scheduledDocs: FakeDoc[] = []) {
  const txUpdates: Array<{ id: string; patch: Record<string, any> }> = []

  const snap = (d: FakeDoc) => ({
    id: d.id,
    ref: { __doc: d },
    data: () => d.data,
  })

  function makeQuery(state: { status?: string; futureOnly?: boolean }): any {
    return {
      where: (field: string, op: string, value: any) => makeQuery({
        status: field === 'status' ? value : state.status,
        futureOnly: state.futureOnly || (field === 'scheduleAt' && op === '>'),
      }),
      orderBy: () => makeQuery(state),
      limit: () => makeQuery(state),
      get: async () => {
        let docs = state.status === 'processing'
          ? processingDocs
          : state.status === 'scheduled' ? scheduledDocs : []
        if (state.futureOnly) docs = []
        return { empty: docs.length === 0, docs: docs.map(snap) }
      },
    }
  }

  const db = {
    collection: () => makeQuery({}),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      const tx = {
        get: async (ref: any) => ({ exists: true, data: () => ref.__doc.data }),
        update: (ref: any, patch: Record<string, any>) => {
          txUpdates.push({ id: ref.__doc.id, patch })
        },
      }
      return fn(tx)
    },
  }

  mockGetDb.mockReturnValue(db as any)
  return { txUpdates }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('看門狗：收殮卡死在 processing 的推播', () => {
  it('卡超過 10 分鐘且認領後零寫入 → 標 failed、註明沒人收到可安全重發', async () => {
    const { txUpdates } = makeDb([{
      id: 'b1',
      data: { workspaceId: 'w1', name: 'AROMIC預熱', status: 'processing', startedAt: ts(20 * MIN), updatedAt: ts(20 * MIN) },
    }])

    const out = await runDueScheduledBroadcasts()

    expect(out.reaped).toBe(1)
    expect(txUpdates).toHaveLength(1)
    expect(txUpdates[0]!.patch.status).toBe('failed')
    expect(txUpdates[0]!.patch.failureReason).toContain('沒有任何人收到')
  })

  it('卡死但受眾快照已寫入（updatedAt > startedAt）→ 註明無法確認、要人工查證再重發', async () => {
    const { txUpdates } = makeDb([{
      id: 'b2',
      data: { workspaceId: 'w1', status: 'processing', startedAt: ts(30 * MIN), updatedAt: ts(29 * MIN) },
    }])

    const out = await runDueScheduledBroadcasts()

    expect(out.reaped).toBe(1)
    expect(txUpdates[0]!.patch.failureReason).toContain('無法確認')
  })

  it('processing 未滿 10 分鐘 → 是活單，不能動', async () => {
    const { txUpdates } = makeDb([{
      id: 'b3',
      data: { workspaceId: 'w1', status: 'processing', startedAt: ts(2 * MIN), updatedAt: ts(2 * MIN) },
    }])

    const out = await runDueScheduledBroadcasts()

    expect(out.reaped).toBe(0)
    expect(txUpdates).toHaveLength(0)
  })

  it('指定 workspaceId 時不動別的工作區的卡單', async () => {
    const { txUpdates } = makeDb([{
      id: 'b4',
      data: { workspaceId: 'w1', status: 'processing', startedAt: ts(20 * MIN), updatedAt: ts(20 * MIN) },
    }])

    const out = await runDueScheduledBroadcasts({ workspaceId: 'other-ws' })

    expect(out.reaped).toBe(0)
    expect(txUpdates).toHaveLength(0)
  })

  it('transaction 內發現狀態已被別人改掉 → 不寫入也不計入收殮數（防競態重複收殮）', async () => {
    // 查詢時還是 processing、transaction 重讀時已變 completed（模擬另一個實例剛寫完結果）
    const { txUpdates } = makeDb([{
      id: 'b5',
      data: { workspaceId: 'w1', status: 'completed', startedAt: ts(20 * MIN), updatedAt: ts(20 * MIN) },
    }])

    const out = await runDueScheduledBroadcasts()

    expect(out.reaped).toBe(0)
    expect(txUpdates).toHaveLength(0)
  })

  it('看門狗收殮後，到期的 scheduled 單照常發送（兩件事同一輪都要做）', async () => {
    makeDb(
      [{ id: 'stuck', data: { workspaceId: 'w1', status: 'processing', startedAt: ts(20 * MIN), updatedAt: ts(20 * MIN) } }],
      [{ id: 'due', data: { workspaceId: 'w1', status: 'scheduled', scheduleAt: ts(1 * MIN) } }],
    )
    mockSend.mockResolvedValue({ success: true, sentCount: 5 } as any)

    const out = await runDueScheduledBroadcasts()

    expect(out.reaped).toBe(1)
    expect(out.triggered).toBe(1)
    expect(mockSend).toHaveBeenCalledWith('due', { source: 'scheduler' })
  })
})
