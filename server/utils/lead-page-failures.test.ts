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
  recordLeadPageSuccess,
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

  it('成功次數（分母）也一起加起來，而且不算進失敗總數', () => {
    const r = sumFailureBuckets([
      { counts: { load_timeout: 2 }, okCount: 30 },
      { okCount: 12 },
      { counts: { load_timeout: 1 } },
    ])
    expect(r.succeeded).toBe(42)
    expect(r.total).toBe(3)
  })

  it('⛔ 舊桶沒有 okCount 時是 0，不可以變成 NaN（畫面會拿它算比例）', () => {
    const r = sumFailureBuckets([{ counts: { load_timeout: 1 } }, { okCount: 'x' }])
    expect(r.succeeded).toBe(0)
    expect(Number.isNaN(r.succeeded)).toBe(false)
  })

  it('逾時卡在哪一步會逐項加總；不認得的階段要現形不可以靜靜丟掉', () => {
    const r = sumFailureBuckets([
      { stages: { load_sdk: 3, liff_init: 1 } },
      { stages: { load_sdk: 2, some_new_stage: 5 } },
    ])
    expect(r.byTimeoutStage.load_sdk).toBe(5)
    expect(r.byTimeoutStage.liff_init).toBe(1)
    expect(r.byTimeoutStage.claiming).toBe(0)
    expect(r.unknownStages).toEqual(['some_new_stage'])
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

  it('逾時會把「卡在哪一步」也 increment 下去（只靠 lastDetail 一個桶只留得住一筆）', async () => {
    const set = vi.fn(async () => {})
    const db = { collection: () => ({ doc: () => ({ set }) }) } as never
    await recordLeadPageFailure(db, { workspaceId: 'ws1', reason: 'load_timeout', stage: 'load_sdk' })
    const [payload] = set.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(payload.stages).toEqual({ load_sdk: { __inc: 1 } })
  })

  it('⛔ 只有逾時才記階段：其他原因就算傳了 stage 也不寫（那格只對逾時有意義）', async () => {
    const set = vi.fn(async () => {})
    const db = { collection: () => ({ doc: () => ({ set }) }) } as never
    await recordLeadPageFailure(db, { workspaceId: 'ws1', reason: 'claim_failed', stage: 'claiming' })
    const [payload] = set.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(payload.stages).toBeUndefined()
  })
})

describe('recordLeadPageSuccess', () => {
  it('跟失敗寫進同一份桶文件，只加 okCount（這樣讀失敗那支查詢就順便撈到分母，不用開新索引）', async () => {
    const set = vi.fn(async () => {})
    const doc = vi.fn(() => ({ set }))
    const db = { collection: vi.fn(() => ({ doc })) } as never

    await recordLeadPageSuccess(db, 'ws1')

    // 文件 id 是「工作區＋小時」：mock 沒宣告參數型別，取值前先轉一次（2026-09-16 修 typecheck 紅）
    expect((doc.mock.calls as unknown as [string][])[0]?.[0]).toMatch(/^ws1__\d{10}$/)
    expect(set).toHaveBeenCalledTimes(1)
    const [payload, opts] = (set.mock.calls as unknown as [Record<string, unknown>, { merge: boolean }][])[0]!
    expect(opts).toEqual({ merge: true })
    expect(payload.okCount).toEqual({ __inc: 1 })
    // ⛔ 不可以連 counts 一起送：整包 merge 會把同一小時的失敗分項洗掉
    expect(payload.counts).toBeUndefined()
  })

  it('沒有 workspaceId 就什麼都不寫（⛔ 記到別家比不記更糟）', async () => {
    const set = vi.fn(async () => {})
    const db = { collection: () => ({ doc: () => ({ set }) }) } as never
    await recordLeadPageSuccess(db, '  ')
    expect(set).not.toHaveBeenCalled()
  })
})
