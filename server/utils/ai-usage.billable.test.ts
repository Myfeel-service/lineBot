/**
 * 「一則」怎麼算（`D-69` 拍板⑤）：計費訊號 `billable` 與品質指標 `answered` 分家。
 *
 * 這組測試盯的是**收錢**這件事，所以每一條都斷言「額度桶到底有沒有被寫、寫了多少」，
 * 不是只看函式有沒有丟例外——2026-08-30 的教訓：假 db 沒有真的驗副作用，
 * 一筆都沒寫進去測試照樣全綠。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __ts: true }), increment: (n: number) => ({ __inc: n }) },
}))
vi.mock('./firebase', () => ({ getDb: () => { throw new Error('test 必須自帶 db') } }))
vi.mock('./billing', () => ({ getWorkspaceSubscription: vi.fn() }))

import { recordAiUsage, QUOTA_USAGE_COLLECTION, type UsageDelta } from './ai-usage'
import { getWorkspaceSubscription } from './billing'

/** 攔下所有 set()，讓測試能問「額度桶被加了幾則」。 */
function makeDb() {
  const writes: { collection: string; doc: string; data: any }[] = []
  const db = {
    collection: (collection: string) => ({
      doc: (doc: string) => ({
        get: async () => ({ exists: false, data: () => ({}) }),
        set: async (data: any) => { writes.push({ collection, doc, data }) },
      }),
    }),
  } as any
  return { db, writes }
}

/** 額度桶這次被加了幾則；沒被寫回 null（「沒扣」與「扣 0 則」是兩件事）。 */
function quotaCharged(writes: { collection: string; data: any }[]): number | null {
  const w = writes.find(x => x.collection === QUOTA_USAGE_COLLECTION)
  return w ? w.data.answered.__inc : null
}

beforeEach(() => {
  vi.mocked(getWorkspaceSubscription).mockResolvedValue({
    planId: 'lite',
    status: 'active',
    currentPeriodStart: '2026-09-01',
    currentPeriodEnd: '2026-09-30',
  } as any)
})

async function record(delta: UsageDelta) {
  const { db, writes } = makeDb()
  await recordAiUsage('ws1', delta, db)
  return writes
}

describe('哪些情況要扣客人的額度', () => {
  it('AI 答出來 → 扣一則', async () => {
    expect(quotaCharged(await record({ invocations: 1, answered: 1, billable: 1 }))).toBe(1)
  })

  it('AI 反問「你問的是哪一款」→ 也扣一則（D-69 改的就是這條）', async () => {
    expect(quotaCharged(await record({ invocations: 1, disambiguations: 1, billable: 1 }))).toBe(1)
  })

  it('反問後客人點選項、AI 答出來 → 照扣（次數不計避免品質率灌水，但錢要收）', async () => {
    expect(quotaCharged(await record({ followupAnswered: 1, billable: 1 }))).toBe(1)
  })

  it('⛔ AI 說「我不確定，幫你轉真人」→ 不扣。這是對外的賣點，扣了就是說謊', async () => {
    expect(quotaCharged(await record({ invocations: 1, handoffs: 1 }))).toBeNull()
  })

  it('⛔ playground 測試 → 不扣（測試不該花客人的額度）', async () => {
    expect(quotaCharged(await record({ testInvocations: 1, testInputTokens: 500 }))).toBeNull()
  })
})

describe('billable 與 answered 是兩本帳', () => {
  /**
   * 這條是整個改動的核心不變式。把 recordAiUsage 改回「看 answered 決定扣款」的話，
   * 反問就會白做工（那次沒有 answered）——這條會紅。
   */
  it('額度桶只看 billable：光有 answered 不扣錢', async () => {
    expect(quotaCharged(await record({ invocations: 1, answered: 1 }))).toBeNull()
  })

  it('品質指標照舊進月結桶，不受計費口徑影響', async () => {
    const writes = await record({ invocations: 1, answered: 1, billable: 1 })
    const monthly = writes.find(w => w.collection !== QUOTA_USAGE_COLLECTION)!
    expect(monthly.data.answered.__inc).toBe(1)
    expect(monthly.data.invocations.__inc).toBe(1)
  })

  it('一次回答拆成多則訊息也只扣一則（數的是出手次數，不是訊息數）', async () => {
    expect(quotaCharged(await record({ invocations: 1, answered: 1, billable: 1 }))).toBe(1)
  })
})

describe('額度桶寫不進去的時候', () => {
  it('訂閱讀不到（沒有本期）→ 跳過扣款，不要因為記帳失敗擋掉客人的回覆', async () => {
    vi.mocked(getWorkspaceSubscription).mockResolvedValue(null)
    expect(quotaCharged(await record({ invocations: 1, answered: 1, billable: 1 }))).toBeNull()
  })
})
