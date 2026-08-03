import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nuxt auto-import：只需要 clickTrackingBaseUrl
vi.stubGlobal('useRuntimeConfig', () => ({ clickTrackingBaseUrl: '' }))

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
  Timestamp: { now: () => ({ toMillis: () => 0 }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))
vi.mock('./line', () => ({ multicastMessage: vi.fn() }))
vi.mock('./broadcast-claim', () => ({ claimBroadcastForSend: vi.fn() }))
vi.mock('./audience', () => ({ resolveAudienceUserIds: vi.fn() }))
vi.mock('./handler', () => ({ renderModuleToLineMessages: vi.fn() }))
vi.mock('./broadcast-click-track', () => ({
  wrapBroadcastMessagesForClickTracking: vi.fn((m: unknown) => m),
}))

import { executeBroadcastSend } from './broadcast-send'
import { getDb } from './firebase'
import { multicastMessage } from './line'
import { claimBroadcastForSend } from './broadcast-claim'

const mockGetDb = vi.mocked(getDb)
const mockMulticast = vi.mocked(multicastMessage)
const mockClaim = vi.mocked(claimBroadcastForSend)

type Patch = Record<string, any>

/**
 * 假 Firestore：
 * - failCommit：batch.commit() 拋錯（真實事故就是這裡逾時，而資料其實已落地）
 * - failStatusWriteNth：讓第 N 次「帶 status 的寫入」拋錯（1=checkpoint、2=最終統計、3=catch 補寫）
 *   之所以只數帶 status 的，是為了不受前面受眾快照等其他 update 影響
 */
function makeDb(opts: { failCommit?: boolean; failStatusWriteNth?: number[] } = {}) {
  const updates: Patch[] = []
  const deliveries: Patch[] = []
  let statusWrites = 0

  const ref = {
    update: vi.fn(async (patch: Patch) => {
      if ('status' in patch) {
        statusWrites++
        if (opts.failStatusWriteNth?.includes(statusWrites)) throw new Error('update-boom')
      }
      updates.push(patch)
    }),
    collection: vi.fn(() => ({ doc: vi.fn(() => ({ id: 'delivery' })) })),
  }

  const db = {
    collection: vi.fn(() => ({ doc: vi.fn(() => ref) })),
    batch: vi.fn(() => ({
      set: vi.fn((_r: unknown, doc: Patch) => { deliveries.push(doc) }),
      commit: vi.fn(async () => {
        if (opts.failCommit) throw new Error('commit-boom')
      }),
    })),
  }

  mockGetDb.mockReturnValue(db as any)
  return { updates, deliveries, ref }
}

/** audienceSource=import：受眾直接來自陣列，不必假造 users 查詢 */
function claimReturns(userIds: string[]) {
  mockClaim.mockResolvedValue({
    workspaceId: 'w1',
    status: 'processing',
    messages: [{ type: 'text', text: 'hi' }],
    audienceSource: { type: 'import', importedUserIds: userIds },
  } as any)
}

/** 送出後的第一筆結果寫入（checkpoint）；狀態與人數在此就該定局 */
const checkpointPatch = (updates: Patch[]) => updates.find(u => 'status' in u)
/** 最後一筆結果寫入——報表最終看到的值 */
const lastStatusPatch = (updates: Patch[]) => [...updates].reverse().find(u => 'status' in u)

beforeEach(() => {
  mockGetDb.mockReset()
  mockMulticast.mockReset()
  mockClaim.mockReset()
})

describe('executeBroadcastSend — 送出後記帳失敗不可謊報失敗', () => {
  it('全員送達 → 一筆 deliveries 都不寫（消掉大量推播最容易逾時的一步）', async () => {
    claimReturns(['w1_U1', 'w1_U2', 'w1_U3'])
    mockMulticast.mockResolvedValue({ successCount: 3, failedIds: [], lineAggregationApplied: true })
    // commit 只要被呼叫就會炸；沒炸即證明完全沒進批次寫入
    const { deliveries } = makeDb({ failCommit: true })

    const res = await executeBroadcastSend('bc1')
    expect(res).toMatchObject({ success: true, sentCount: 3, failedCount: 0 })
    expect(res.postSendError).toBeNull()
    expect(deliveries).toEqual([])
  })

  it('只把沒收到的人寫進 deliveries，成功者不逐筆記錄', async () => {
    claimReturns(['w1_U1', 'w1_U2', 'w1_U3'])
    mockMulticast.mockResolvedValue({ successCount: 2, failedIds: ['U2'], lineAggregationApplied: true })
    const { deliveries } = makeDb()

    await executeBroadcastSend('bc1')

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      userId: 'w1_U2',
      deliveryStatus: 'failed',
      sentAt: null,
    })
  })

  it('失敗名單寫入掛掉：訊息已送出 → 狀態仍是 completed，成功數照實寫', async () => {
    claimReturns(['w1_U1', 'w1_U2', 'w1_U3'])
    mockMulticast.mockResolvedValue({ successCount: 2, failedIds: ['U2'], lineAggregationApplied: true })
    const { updates } = makeDb({ failCommit: true })

    // 名單寫失敗不該讓整個發送流程視為失敗
    const res = await executeBroadcastSend('bc1')
    expect(res).toMatchObject({ success: true, sentCount: 2, failedCount: 1 })
    // 誠實揭露名單不全，而不是靜靜當作一切正常
    expect(res.postSendError).toContain('沒收到的名單未寫完')

    const final = lastStatusPatch(updates)!
    expect(final.status).toBe('completed')
    expect(final.sentCount).toBe(2)
    expect(final.failedCount).toBe(1)
    expect(final.postSendError).toContain('沒收到的名單未寫完')
  })

  it('最終統計寫入掛掉：catch 仍把狀態寫成 completed，且不對外報發送失敗', async () => {
    claimReturns(['w1_U1', 'w1_U2', 'w1_U3'])
    mockMulticast.mockResolvedValue({ successCount: 3, failedIds: [], lineAggregationApplied: true })
    // checkpoint 成功、最終統計掛掉、catch 補寫成功
    const { updates } = makeDb({ failStatusWriteNth: [2] })

    // 訊息已送出，呼叫端不可收到錯誤——否則畫面會顯示「發送失敗」而被重發
    const res = await executeBroadcastSend('bc1')
    expect(res).toMatchObject({ success: true, sentCount: 3, failedCount: 0 })
    expect(res.postSendError).toContain('訊息已送出')

    const final = lastStatusPatch(updates)!
    expect(final.status).toBe('completed')
    expect(final.sentCount).toBe(3)
    expect(final.postSendError).toContain('訊息已送出')
  })

  it('送出後每一次寫入都掛掉：checkpoint 已先把狀態與人數寫死，不會卡在 processing', async () => {
    claimReturns(['w1_U1', 'w1_U2', 'w1_U3'])
    mockMulticast.mockResolvedValue({ successCount: 3, failedIds: [], lineAggregationApplied: true })
    // checkpoint 之後的兩次結果寫入都掛掉
    const { updates } = makeDb({ failStatusWriteNth: [2, 3] })

    const res = await executeBroadcastSend('bc1')
    expect(res.sentCount).toBe(3)

    // checkpoint 必須自帶 status，否則後續全失敗時會永遠停在 processing、無法編輯或重發
    const checkpoint = checkpointPatch(updates)!
    expect(checkpoint.status).toBe('completed')
    expect(checkpoint.sentCount).toBe(3)
    expect(checkpoint.failedCount).toBe(0)
    expect(checkpoint.lineInsightAggregationApplied).toBe(true)
  })

  it('LINE 真的全數退回 → 才是 failed', async () => {
    claimReturns(['w1_U1', 'w1_U2'])
    mockMulticast.mockResolvedValue({
      successCount: 0,
      failedIds: ['U1', 'U2'],
      lineAggregationApplied: true,
    })
    const { updates } = makeDb()

    const res = await executeBroadcastSend('bc1')
    expect(res.sentCount).toBe(0)

    const final = lastStatusPatch(updates)!
    expect(final.status).toBe('failed')
    expect(final.failedCount).toBe(2)
    expect(final.postSendError).toBeNull()
  })

  it('名單有無效收件人被濾掉、其餘全退回 → 仍要判成 failed（不可寫成已完成）', async () => {
    // 空字串轉不出 LINE userId 會被濾掉：resolvedUserIds=3 但實際只送 2 人
    claimReturns(['w1_U1', 'w1_', 'w1_U2'])
    mockMulticast.mockResolvedValue({
      successCount: 0,
      failedIds: ['U1', 'U2'],
      lineAggregationApplied: true,
    })
    const { updates } = makeDb()

    await executeBroadcastSend('bc1')

    // 用 resolvedUserIds(3) 當母體比 failedIds(2) 會判成 completed，報表就會出現「已完成／成功 0」
    const final = lastStatusPatch(updates)!
    expect(final.status).toBe('failed')
    expect(final.sentCount).toBe(0)
  })

  it('還沒送出就失敗（受眾為空）→ 維持 failed，且不寫成功數', async () => {
    claimReturns([])
    const { updates } = makeDb()

    await expect(executeBroadcastSend('bc1')).rejects.toThrow('Resolved audience is empty')
    expect(mockMulticast).not.toHaveBeenCalled()

    const final = lastStatusPatch(updates)!
    expect(final.status).toBe('failed')
    expect(final).not.toHaveProperty('sentCount')
  })

  it('LINE 未套用彙總單位時不寫 unit，報表才知道查不到開封數', async () => {
    claimReturns(['w1_U1'])
    mockMulticast.mockResolvedValue({ successCount: 1, failedIds: [], lineAggregationApplied: false })
    const { updates } = makeDb()

    await executeBroadcastSend('bc1')

    const final = lastStatusPatch(updates)!
    expect(final.lineAggregationUnit).toBeNull()
    expect(final.lineInsightAggregationApplied).toBe(false)
  })
})
