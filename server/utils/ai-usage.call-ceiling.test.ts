/**
 * 呼叫上限（`C-8`）的記帳與讀取：
 *   · 被額度擋下的那次記 quotaBlocked（AI 沒出手），不扣則。
 *   · 這個月 AI 被叫幾次從月結桶讀、扣掉沒出手的，60 秒快取（每則客人訊息都會問一次）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __ts: true }), increment: (n: number) => ({ __inc: n }) },
}))
vi.mock('./firebase', () => ({ getDb: () => { throw new Error('test 必須自帶 db') } }))
vi.mock('./billing', () => ({ getWorkspaceSubscription: vi.fn(async () => ({ planId: 'lite', status: 'active', currentPeriodStart: '2026-10-01', currentPeriodEnd: '2026-10-31' })) }))

import { AI_USAGE_COLLECTION, QUOTA_USAGE_COLLECTION, currentYyyyMm, getCurrentMonthAiCalls, invalidateAiCallsCache, recordAiUsage } from './ai-usage'

function makeDb(monthDoc: Record<string, unknown> | null = null) {
  const writes: { collection: string, doc: string, data: any }[] = []
  const reads: string[] = []
  const db = {
    collection: (collection: string) => ({
      doc: (doc: string) => ({
        get: async () => {
          reads.push(`${collection}/${doc}`)
          return { exists: monthDoc != null, data: () => monthDoc ?? undefined }
        },
        set: async (data: any) => { writes.push({ collection, doc, data }) },
      }),
    }),
  } as any
  return { db, writes, reads }
}

beforeEach(() => invalidateAiCallsCache())
afterEach(() => vi.useRealTimers())

describe('被額度擋下的那次', () => {
  it('🔴 月結桶記 quotaBlocked（呼叫上限要扣掉它），⛔ 不碰額度桶（不扣則）', async () => {
    const { db, writes } = makeDb()
    await recordAiUsage('ws1', { invocations: 1, handoffs: 1, quotaBlocked: 1 }, db)
    const month = writes.find(w => w.collection === AI_USAGE_COLLECTION)!
    expect(month.data.quotaBlocked).toEqual({ __inc: 1 })
    expect(month.data.invocations).toEqual({ __inc: 1 })
    expect(writes.some(w => w.collection === QUOTA_USAGE_COLLECTION)).toBe(false)
  })
})

describe('getCurrentMonthAiCalls', () => {
  it('讀這個台北月的月結桶，扣掉指名找真人與被擋下的', async () => {
    const { db, reads } = makeDb({ invocations: 700, directHandoffs: 50, quotaBlocked: 150 })
    expect(await getCurrentMonthAiCalls('ws1', db)).toBe(500)
    expect(reads).toEqual([`${AI_USAGE_COLLECTION}/ws1_${currentYyyyMm()}`])
  })

  it('這個月還沒有任何用量 → 0', async () => {
    expect(await getCurrentMonthAiCalls('ws1', makeDb(null).db)).toBe(0)
  })

  it('🔴 60 秒內再問不重讀（每則客人訊息都會問一次，不快取就是每則多一次點讀）；過了 60 秒重讀', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T04:00:00Z'))
    const { db, reads } = makeDb({ invocations: 10 })
    await getCurrentMonthAiCalls('ws1', db)
    await getCurrentMonthAiCalls('ws1', db)
    expect(reads).toHaveLength(1)
    vi.setSystemTime(new Date('2026-10-20T04:01:01Z'))
    await getCurrentMonthAiCalls('ws1', db)
    expect(reads).toHaveLength(2)
  })

  it('跨月那一刻換一格：不拿上個月的次數擋這個月', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-31T15:59:30Z')) // 台北 10/31 23:59:30
    const { db, reads } = makeDb({ invocations: 999 })
    await getCurrentMonthAiCalls('ws1', db)
    vi.setSystemTime(new Date('2026-10-31T16:00:10Z')) // 台北 11/1 00:00:10（快取還沒過 60 秒）
    await getCurrentMonthAiCalls('ws1', db)
    expect(reads).toEqual([`${AI_USAGE_COLLECTION}/ws1_202610`, `${AI_USAGE_COLLECTION}/ws1_202611`])
  })

  it('讀失敗會丟錯（由護欄決定 fail-open），不把失敗快取起來', async () => {
    const db = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('UNAVAILABLE') } }) }) } as any
    await expect(getCurrentMonthAiCalls('ws1', db)).rejects.toThrow('UNAVAILABLE')
    const ok = makeDb({ invocations: 3 })
    expect(await getCurrentMonthAiCalls('ws1', ok.db)).toBe(3)
  })
})
