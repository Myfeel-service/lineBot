import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「客人問了、AI 答不出來」的排程掃描跟每月上限（`C-414`）。
 * ① 圈在「背景」那本：以前只記進那本、沒被圈——它自己用超了照跑，反而把貼標建議、找新標籤擋下來
 * ② 到上限的那家記成這個月先停、換下一家：一輪只掃一家，到上限的那家永遠排最前面（最久沒掃），
 *    直接切前 N 家的話它每輪佔掉名額、撞 429、記成失敗，別家輪不到
 */

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
  Timestamp: { fromMillis: (ms: number) => ({ __ms: ms }) },
}))
vi.mock('./gemini', () => ({ embedQuery: vi.fn(), generateJson: vi.fn(), estimateTokens: () => 1, runWithLlmBudget: vi.fn() }))
vi.mock('./ai-usage', () => ({
  recordAiUsage: vi.fn(),
  AI_USAGE_COLLECTION: 'aiUsage',
  currentYyyyMm: () => '202610',
  getMaintenanceBudgetStatus: vi.fn(),
}))
vi.mock('./ai-handoff-notify', () => ({ notifyKnowledgeSourceEvent: vi.fn() }))
vi.mock('./firebase', () => ({ getDb: vi.fn() }))

const { runWithLlmBudget } = await import('./gemini')
const { getMaintenanceBudgetStatus } = await import('./ai-usage')
const { scanKnowledgeGaps } = await import('./ai-knowledge-suggest')
const { taipeiYyyyMm } = await import('~~/shared/time')

/** 假 Firestore：掃描狀態那一份文件＋「最近有轉真人的」那兩家；寫進狀態文件的全部記下來 */
function fakeDb(state: Record<string, unknown> = {}) {
  const writes: Array<Record<string, any>> = []
  const chain = (docs: unknown[]) => {
    const q: any = { where: () => q, orderBy: () => q, select: () => q, limit: () => q, get: async () => ({ docs }) }
    return q
  }
  const db: any = {
    collection(name: string) {
      if (name === 'cronState') {
        return { doc: () => ({ get: async () => ({ data: () => state }), set: async (d: Record<string, any>) => { writes.push(d) } }) }
      }
      if (name === 'aiHandoffEvents') {
        return chain(['ws_blocked', 'ws_ok'].map(workspaceId => ({ data: () => ({ workspaceId }) })))
      }
      return chain([])
    },
  }
  return { db, writes }
}

const budgetOf = (blocked: Set<string>) => async (ws: string) => ({ used: 0, cap: 1, blocked: blocked.has(ws), kind: 'background' as const })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runWithLlmBudget).mockResolvedValue({ events: 3 } as any)
})

describe('知識缺口掃描跟每月上限（`C-414`）', () => {
  it('到上限的那家記成這個月先停、換下一家掃；掃的時候圈在背景那本', async () => {
    vi.mocked(getMaintenanceBudgetStatus).mockImplementation(budgetOf(new Set(['ws_blocked'])) as any)
    const { db, writes } = fakeDb()
    await scanKnowledgeGaps(db)
    expect(vi.mocked(runWithLlmBudget).mock.calls.map(c => [c[0], c[2]])).toEqual([['ws_ok', 'background']])
    expect(writes).toContainEqual({ ws_blocked: { budgetPausedMonth: taipeiYyyyMm(), leaseUntil: '__del__' } })
    // 掃成功的那家：先停的記號一起收掉
    expect(writes.find(w => w.ws_ok?.lastScanAt)!.ws_ok).toMatchObject({ budgetPausedMonth: '__del__' })
  })

  it('這個月已經記過先停的：不排進來（不查用量、不佔名額）', async () => {
    vi.mocked(getMaintenanceBudgetStatus).mockImplementation(budgetOf(new Set()) as any)
    const { db } = fakeDb({ ws_blocked: { budgetPausedMonth: taipeiYyyyMm() } })
    await scanKnowledgeGaps(db)
    expect(vi.mocked(getMaintenanceBudgetStatus).mock.calls.map(c => c[0])).toEqual(['ws_ok'])
    expect(vi.mocked(runWithLlmBudget).mock.calls.map(c => c[0])).toEqual(['ws_ok'])
  })

  it('掃到一半撞到上限：記成先停、還掉租約，⛔ 不寫「上次分析沒跑成」、不寫上次掃描時間', async () => {
    vi.mocked(getMaintenanceBudgetStatus).mockImplementation(budgetOf(new Set()) as any)
    vi.mocked(runWithLlmBudget).mockRejectedValue(Object.assign(new Error('x'), { statusCode: 429, data: { reason: 'ai_budget' } }))
    const { db, writes } = fakeDb({ ws_ok: { budgetPausedMonth: taipeiYyyyMm() } })
    await scanKnowledgeGaps(db)
    expect(writes).toContainEqual({ ws_blocked: { budgetPausedMonth: taipeiYyyyMm(), leaseUntil: '__del__' } })
    expect(writes.some(w => w.ws_blocked?.lastError || w.ws_blocked?.lastScanAt)).toBe(false)
  })
})
