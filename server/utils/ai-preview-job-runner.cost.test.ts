/**
 * 匯入工作推進出錯時，這一步已經花掉的錢要先入帳（`C-338`②）。
 *
 * 以前：一批切卡有幾段成功、一段失敗整步丟錯 → 成功那幾段的 token 已經加進 work.usage，
 * 但 catch 不結清，記憶體裡的 work 一丟就沒人記了（存回去的進度停在上一步、下一輪重做只記重做那次）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
  Timestamp: { fromMillis: (ms: number) => ({ __ts: ms }) },
}))
vi.mock('./firebase', () => ({ getDb: () => { throw new Error('test 必須自帶 db') }, getStorage: () => ({}) }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./gemini', async importOriginal => ({
  ...(await importOriginal<typeof import('./gemini')>()),
  runWithLlmBudget: (_ws: string, fn: () => Promise<unknown>) => fn(),
}))
const h = vi.hoisted(() => ({ work: null as any }))
vi.mock('./ai-preview-jobs', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-preview-jobs')>()),
  loadWorkWithGeneration: vi.fn(async () => ({ work: h.work, generation: 1 })),
  saveWork: vi.fn(async () => 2),
  advanceWork: vi.fn(),
}))

const { advancePreviewJob } = await import('./ai-preview-job-runner')
const { advanceWork, addJobUsage, makeWork } = await import('./ai-preview-jobs')
const { recordAiUsage } = await import('./ai-usage')

function makeDb() {
  const updates: any[] = []
  const ref = {
    get: async () => ({ data: () => ({ phase: 'chunk', transientErrors: 0 }) }),
    update: async (p: any) => { updates.push(p) },
  }
  const db = {
    collection: () => ({ doc: () => ref }),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
      get: async () => ({ exists: true, data: () => ({ workspaceId: 'ws1', status: 'processing', leaseUntil: 0, phase: 'chunk' }) }),
      update: () => {},
    }),
  } as any
  return { db, updates }
}

beforeEach(() => {
  vi.mocked(recordAiUsage).mockClear()
  h.work = makeWork({ type: 'text', generateOverview: false })
  h.work.phase = 'chunk'
  h.work.segments = ['a', 'b']
})

describe('advancePreviewJob 出錯時結清已花的錢', () => {
  it('⛔ 一步裡有幾段先成功（錢付了）、後面丟錯：catch 要把那幾段入帳，帶著模型', async () => {
    vi.mocked(advanceWork).mockImplementationOnce(async (work: any) => {
      addJobUsage(work.usage, [{ model: 'gemini-2.5-flash', inputTokens: 4000, outputTokens: 900 }])
      throw Object.assign(new Error('寫入失敗'), { statusCode: 500 })
    })
    const { db } = makeDb()
    const out = await advancePreviewJob(db, 'ws1', 'job1')
    expect(out.status).toBe('error')
    expect(recordAiUsage).toHaveBeenCalledWith('ws1', {
      inputTokens: 4000,
      outputTokens: 900,
      importInputTokens: 4000,
      importOutputTokens: 900,
      modelTokens: { build: { flash: { input: 4000, output: 900 } } },
    })
  })

  it('一步正常做完：照舊每步結清一次，不會因為多了 catch 而重複記', async () => {
    vi.mocked(advanceWork).mockImplementationOnce(async (work: any) => {
      addJobUsage(work.usage, [{ model: 'gemini-2.5-flash', inputTokens: 100, outputTokens: 10 }])
      work.phase = 'finalize'
      return work
    })
    const { db } = makeDb()
    const out = await advancePreviewJob(db, 'ws1', 'job1')
    expect(out.status).toBe('processing')
    expect(recordAiUsage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordAiUsage).mock.calls[0]![1]).toMatchObject({ inputTokens: 100, outputTokens: 10 })
  })
})
