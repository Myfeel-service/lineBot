import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    increment: (n: number) => ({ __inc: n }),
    serverTimestamp: () => '__ts__',
  },
  Timestamp: { fromMillis: (ms: number) => ({ __ts: ms }) },
}))

const {
  hourBucketKey,
  hourBucketStart,
  failureBucketDocId,
  sumFailureBuckets,
  recordLeadPageFailure,
} = await import('./lead-page-failures')

describe('桶鍵（純函式）', () => {
  it('同一小時內的兩個時刻落在同一個桶', () => {
    const a = new Date('2026-09-10T07:00:01.000Z')
    const b = new Date('2026-09-10T07:59:59.000Z')
    expect(hourBucketKey(a)).toBe('2026091007')
    expect(hourBucketKey(a)).toBe(hourBucketKey(b))
  })

  it('跨過整點就換桶', () => {
    expect(hourBucketKey(new Date('2026-09-10T08:00:00.000Z'))).toBe('2026091008')
  })

  it('桶起始時刻是該小時的 0 分 0 秒', () => {
    expect(hourBucketStart(new Date('2026-09-10T07:23:45.678Z')).toISOString())
      .toBe('2026-09-10T07:00:00.000Z')
  })

  it('⛔ workspaceId 含斜線要換掉（Firestore 的 doc id 不能有）', () => {
    expect(failureBucketDocId('ws/1', '2026091007')).toBe('ws_1__2026091007')
    expect(failureBucketDocId('linebot-e8dda', '2026091007')).toBe('linebot-e8dda__2026091007')
  })
})

describe('sumFailureBuckets', () => {
  it('把多個桶加起來，沒出現過的原因是 0 不是缺欄位', () => {
    const r = sumFailureBuckets([
      { counts: { liff_init_failed: 2, link_incomplete: 1 } },
      { counts: { liff_init_failed: 3 } },
    ])
    expect(r.byReason.liff_init_failed).toBe(5)
    expect(r.byReason.link_incomplete).toBe(1)
    expect(r.byReason.claim_failed).toBe(0)
    expect(r.total).toBe(6)
  })

  it('⛔ 不認得的代碼要現形，不可以靜靜丟掉（舊版寫進去的會整批消失）', () => {
    const r = sumFailureBuckets([{ counts: { some_old_code: 4, load_timeout: 1 } }])
    expect(r.unknownReasons).toEqual(['some_old_code'])
    // 不認得也要算進總數，否則「總共幾次」會比分項加起來還少
    expect(r.total).toBe(5)
  })

  it('壞掉的值（負數、非數字、空桶）不列入', () => {
    const r = sumFailureBuckets([
      { counts: { load_timeout: -3 } },
      { counts: { load_timeout: 'x' as unknown as number } },
      {},
    ])
    expect(r.total).toBe(0)
    expect(r.byReason.load_timeout).toBe(0)
  })
})

describe('recordLeadPageFailure', () => {
  it('真的寫下去，而且是 merge + increment（整包覆蓋會把同一小時前面幾次清掉）', async () => {
    const set = vi.fn(async () => {})
    const doc = vi.fn(() => ({ set }))
    const db = { collection: vi.fn(() => ({ doc })) } as never

    await recordLeadPageFailure(db, {
      workspaceId: 'ws1',
      reason: 'liff_init_failed',
      campaignCode: 'launch_2026',
      detail: 'boom',
    })

    expect(set).toHaveBeenCalledTimes(1)
    const [payload, opts] = set.mock.calls[0] as unknown as [Record<string, unknown>, { merge: boolean }]
    expect(opts).toEqual({ merge: true })
    expect(payload.workspaceId).toBe('ws1')
    expect(payload.counts).toEqual({ liff_init_failed: { __inc: 1 } })
    expect(payload.expireAt).toBeTruthy()
  })

  it('detail 會截斷，不整段吞進去（客人的網址可能帶參數）', async () => {
    const set = vi.fn(async () => {})
    const db = { collection: () => ({ doc: () => ({ set }) }) } as never
    await recordLeadPageFailure(db, { workspaceId: 'ws1', reason: 'claim_failed', detail: 'x'.repeat(500) })
    const [payload] = set.mock.calls[0] as unknown as [Record<string, string>]
    expect(payload.lastDetail).toHaveLength(200)
  })
})
