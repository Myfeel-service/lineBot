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
import { BROADCAST_STUCK_SAFE_TO_RESEND, BROADCAST_STUCK_UNVERIFIED } from '~~/shared/broadcast-failure'

const mockGetDb = vi.mocked(getDb)
const mockSend = vi.mocked(executeBroadcastSend)

const MIN = 60_000
/** 固定基準時刻：startedAt / updatedAt 要能精準比大小，不能各自 Date.now() */
const NOW = Date.now()

/** Admin SDK Timestamp 的形狀（parseFirestoreDate 走 toDate()） */
const ts = (msAgo: number) => {
  const ms = NOW - msAgo
  return {
    toDate: () => new Date(ms),
    toMillis: () => ms,
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1e6,
  }
}
/** API JSON 還原後常見的形狀（沒有 toDate/toMillis，只有 _seconds） */
const tsJsonShape = (msAgo: number) => ({ _seconds: Math.floor((NOW - msAgo) / 1000), _nanoseconds: 0 })

type FakeDoc = { id: string; data: Record<string, any> }

/**
 * 假 Firestore：只認 status 等值條件——processing 回卡單、scheduled 回到期單，
 * scheduleAt '>' 的除錯查詢一律回空。runTransaction 的 tx.get 讀「當下」的 doc.data
 * （測試可在查詢後改 data 模擬競態）。
 */
function makeDb(processingDocs: FakeDoc[], scheduledDocs: FakeDoc[] = []) {
  const txUpdates: Array<{ id: string; patch: Record<string, any> }> = []
  const selectedFields: string[][] = []

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
      select: (...fields: string[]) => {
        selectedFields.push(fields)
        return makeQuery(state)
      },
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
  return { txUpdates, selectedFields }
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
    expect(txUpdates[0]!.patch.failureReason).toBe(BROADCAST_STUCK_SAFE_TO_RESEND)
  })

  it('卡死但受眾快照已寫入（updatedAt > startedAt）→ 註明無法確認、要人工查證再重發', async () => {
    const { txUpdates } = makeDb([{
      id: 'b2',
      data: { workspaceId: 'w1', status: 'processing', startedAt: ts(30 * MIN), updatedAt: ts(29 * MIN) },
    }])

    const out = await runDueScheduledBroadcasts()

    expect(out.reaped).toBe(1)
    expect(txUpdates[0]!.patch.failureReason).toBe(BROADCAST_STUCK_UNVERIFIED)
  })

  // ⛔這組是「說錯話會害人重複轟炸整份名單」的那一側：時間戳只要有一點判讀不出來，
  //   就不可以退回「沒有任何人收到，可以放心重發」
  it('updatedAt 缺欄位 → 不可判成「沒人收到」，一律走無法確認', async () => {
    const { txUpdates } = makeDb([{
      id: 'b3',
      data: { workspaceId: 'w1', status: 'processing', startedAt: ts(20 * MIN) },
    }])

    const out = await runDueScheduledBroadcasts()

    expect(out.reaped).toBe(1)
    expect(txUpdates[0]!.patch.failureReason).toBe(BROADCAST_STUCK_UNVERIFIED)
  })

  it('updatedAt 是 {_seconds} 形狀且與 startedAt 同一秒 → 讀得懂，判成可安全重發', async () => {
    const { txUpdates } = makeDb([{
      id: 'b4',
      data: { workspaceId: 'w1', status: 'processing', startedAt: tsJsonShape(20 * MIN), updatedAt: tsJsonShape(20 * MIN) },
    }])

    const out = await runDueScheduledBroadcasts()

    expect(out.reaped).toBe(1)
    expect(txUpdates[0]!.patch.failureReason).toBe(BROADCAST_STUCK_SAFE_TO_RESEND)
  })

  it('兩個時間都讀不出來 → 照樣收殮（否則永遠卡住又占滿查詢名額），文案走無法確認', async () => {
    const { txUpdates } = makeDb([{
      id: 'b5',
      data: { workspaceId: 'w1', status: 'processing', startedAt: null, updatedAt: 'not-a-time' },
    }])

    const out = await runDueScheduledBroadcasts()

    expect(out.reaped).toBe(1)
    expect(txUpdates[0]!.patch.failureReason).toBe(BROADCAST_STUCK_UNVERIFIED)
  })

  it('processing 未滿 10 分鐘 → 是活單，不能動', async () => {
    const { txUpdates } = makeDb([{
      id: 'b6',
      data: { workspaceId: 'w1', status: 'processing', startedAt: ts(2 * MIN), updatedAt: ts(2 * MIN) },
    }])

    const out = await runDueScheduledBroadcasts()

    expect(out.reaped).toBe(0)
    expect(txUpdates).toHaveLength(0)
  })

  it('開始很久但剛剛還有寫入（受眾解析中）→ 用最後進度算，不能誤殺', async () => {
    const { txUpdates } = makeDb([{
      id: 'b7',
      data: { workspaceId: 'w1', status: 'processing', startedAt: ts(30 * MIN), updatedAt: ts(1 * MIN) },
    }])

    const out = await runDueScheduledBroadcasts()

    expect(out.reaped).toBe(0)
    expect(txUpdates).toHaveLength(0)
  })

  it('指定 workspaceId 時不動別的工作區的卡單', async () => {
    const { txUpdates } = makeDb([{
      id: 'b8',
      data: { workspaceId: 'w1', status: 'processing', startedAt: ts(20 * MIN), updatedAt: ts(20 * MIN) },
    }])

    const out = await runDueScheduledBroadcasts({ workspaceId: 'other-ws' })

    expect(out.reaped).toBe(0)
    expect(txUpdates).toHaveLength(0)
  })

  it('transaction 內發現狀態已被別人改掉 → 不寫入也不計入收殮數（防競態重複收殮）', async () => {
    // 查詢時還是 processing、transaction 重讀時已變 completed（模擬另一個實例剛寫完結果）
    const { txUpdates } = makeDb([{
      id: 'b9',
      data: { workspaceId: 'w1', status: 'completed', startedAt: ts(20 * MIN), updatedAt: ts(20 * MIN) },
    }])

    const out = await runDueScheduledBroadcasts()

    expect(out.reaped).toBe(0)
    expect(txUpdates).toHaveLength(0)
  })

  it('查詢只取判斷用得到的欄位（不把受眾名單與訊息快照整包搬回來）', async () => {
    const { selectedFields } = makeDb([])

    await runDueScheduledBroadcasts()

    expect(selectedFields[0]).toEqual(['workspaceId', 'name', 'startedAt', 'updatedAt'])
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
