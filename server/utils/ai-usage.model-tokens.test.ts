/**
 * recordAiUsage 寫「照模型拆的明細」（`D-130`②）＋「記帳永遠不拖垮主流程」（`C-338` 補記帳時一起收）。
 *
 * ⛔ 每一條都斷言「真的寫進去了什麼」：記帳自己吞錯，一筆都沒寫進去跟正常寫入在呼叫端長得一模一樣
 *    （記憶 feedback_verify_new_code_actually_runs 第三種假綠燈）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __ts: true }), increment: (n: number) => ({ __inc: n }) },
}))
const h = vi.hoisted(() => ({ getDb: vi.fn() }))
vi.mock('./firebase', () => ({ getDb: h.getDb }))
vi.mock('./billing', () => ({ getWorkspaceSubscription: vi.fn(async () => null) }))

import { AI_USAGE_COLLECTION, recordAiUsage } from './ai-usage'
import { usageFromCalls } from './ai-usage-calls'

function makeDb() {
  const writes: { collection: string; doc: string; data: any; opts: any }[] = []
  const db = {
    collection: (collection: string) => ({
      doc: (doc: string) => ({
        set: async (data: any, opts: any) => { writes.push({ collection, doc, data, opts }) },
      }),
    }),
  } as any
  return { db, writes }
}

beforeEach(() => {
  h.getDb.mockReset()
})

describe('照模型拆的明細寫進月結桶', () => {
  it('明細寫成巢狀 increment（merge:true＝其他模型、其他桶的明細不會被蓋掉），總數照寫', async () => {
    const { db, writes } = makeDb()
    await recordAiUsage('ws1', {
      invocations: 1,
      ...usageFromCalls('conversation', [
        { model: 'gemini-2.5-flash-lite', inputTokens: 300, outputTokens: 40 },
        { model: 'gemini-2.5-flash', inputTokens: 2000, outputTokens: 120 },
      ]),
    }, db)
    const w = writes.find(x => x.collection === AI_USAGE_COLLECTION)!
    expect(w.opts).toEqual({ merge: true })
    expect(w.data.inputTokens).toEqual({ __inc: 2300 })
    expect(w.data.outputTokens).toEqual({ __inc: 160 })
    expect(w.data.modelTokens).toEqual({
      conversation: {
        flashLite: { input: { __inc: 300 }, output: { __inc: 40 } },
        flash: { input: { __inc: 2000 }, output: { __inc: 120 } },
      },
    })
  })

  it('生圖記在後台自用那桶的 flashImage 底下', async () => {
    const { db, writes } = makeDb()
    await recordAiUsage('ws1', {
      ...usageFromCalls('test', [{ model: 'gemini-2.5-flash-image', inputTokens: 40, outputTokens: 1290 }]),
      testInvocations: 1,
    }, db)
    const w = writes.find(x => x.collection === AI_USAGE_COLLECTION)!
    expect(w.data.testOutputTokens).toEqual({ __inc: 1290 })
    expect(w.data.modelTokens).toEqual({ test: { flashImage: { input: { __inc: 40 }, output: { __inc: 1290 } } } })
    expect(w.data.inputTokens).toBeUndefined()
  })

  it('不認得的桶或模型 key 不寫（防有人手寫明細寫歪）', async () => {
    const { db, writes } = makeDb()
    await recordAiUsage('ws1', {
      inputTokens: 10,
      modelTokens: { conversation: { 'gemini.9': { input: 10 } } as any, bogus: { flash: { input: 1 } } } as any,
    }, db)
    const w = writes.find(x => x.collection === AI_USAGE_COLLECTION)!
    expect(w.data.inputTokens).toEqual({ __inc: 10 })
    expect(w.data.modelTokens).toBeUndefined()
  })
})

describe('⛔ 記帳永遠不丟錯、不白寫', () => {
  it('拿不到資料庫（getDb 直接丟錯）也不會變成 rejected promise', async () => {
    h.getDb.mockImplementation(() => { throw new Error('firebase 沒初始化') })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordAiUsage('ws1', { inputTokens: 5 })).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('資料庫同步丟錯（collection 本身爆掉）也一樣吞掉', async () => {
    const db = { collection: () => { throw new Error('boom') } } as any
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(recordAiUsage('ws1', { inputTokens: 5 }, db)).resolves.toBeUndefined()
    err.mockRestore()
  })

  it('什麼都沒花（空的、全是 0）就不寫——空寫一次也是一筆寫入費', async () => {
    const { db, writes } = makeDb()
    await recordAiUsage('ws1', {}, db)
    await recordAiUsage('ws1', usageFromCalls('build', []), db)
    await recordAiUsage('ws1', { inputTokens: 0, outputTokens: 0 }, db)
    expect(writes).toHaveLength(0)
    expect(h.getDb).not.toHaveBeenCalled()
  })
})
