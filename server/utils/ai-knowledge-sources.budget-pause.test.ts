import { describe, expect, it, vi } from 'vitest'

/**
 * 資料頁那句「自動更新先停下來了」怎麼存、怎麼講（`C-414`）。
 * ① 寫失敗原因一律帶上「是哪一種」：上個月「上限先停」的記號沒收掉，這次 404 會被講成等下個月就好
 * ② 先停只存月份、話在讀的當下才組：存整句的話，12 月還掛著「11 月 1 日恢復」
 * ③ 先停時把舊的失敗收乾淨（失敗次數、「同步失敗」）：體檢、每日摘要不再叫他修一個修不了的東西
 */

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
}))
vi.mock('./knowledge-source-files', () => ({ deleteSourceFiles: vi.fn(async () => {}) }))
vi.mock('./ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  addWorkspaceProductName: vi.fn(),
  buildChunkSoftDeletePatch: vi.fn(),
  getWorkspaceSourceScan: vi.fn(),
  invalidateSourceProductCache: vi.fn(),
  invalidateTagIndexCache: vi.fn(),
  invalidateWorkspaceProductNames: vi.fn(),
}))

const { buildSourceBudgetPause, buildSourceClearFailure, buildSourceFailure, docToSourceSummary } = await import('./ai-knowledge-sources')
const { taipeiYyyyMm } = await import('~~/shared/time')

describe('buildSourceFailure：原因跟「是哪一種」一起寫', () => {
  it('收掉上次留下的「上限先停」記號', () => {
    expect(buildSourceFailure('更新失敗：網址回應 404')).toEqual({
      failureReason: '更新失敗：網址回應 404',
      failureKind: '__del__',
      budgetPausedMonth: '__del__',
    })
  })
})

describe('buildSourceBudgetPause：先停＝先把舊的失敗收乾淨，只存哪個月停的', () => {
  const oct = new Date('2026-10-29T12:00:00+08:00')

  it('之前「同步失敗」的退回正常、失敗次數歸零；⛔ 不存那句話', () => {
    const p = buildSourceBudgetPause('failed', oct)
    expect(p).toMatchObject({ failureKind: 'ai_budget', budgetPausedMonth: '202610', status: 'ready', checkFailCount: '__del__', failureReason: '__del__' })
  })

  it('本來正常的不動 status', () => {
    expect(buildSourceBudgetPause('ready', oct)).not.toHaveProperty('status')
  })

  it('同步成功的清除也會收掉月份', () => {
    expect(buildSourceClearFailure('ready')).toMatchObject({ failureKind: '__del__', budgetPausedMonth: '__del__' })
  })
})

describe('docToSourceSummary：先停的話在讀的當下才組', () => {
  it('這個月停的：pausedByBudget、照現在的日期講幾號恢復', () => {
    const s = docToSourceSummary('s1', { failureKind: 'ai_budget', budgetPausedMonth: taipeiYyyyMm() } as any)
    expect(s.pausedByBudget).toBe(true)
    expect(s.failureReason).toMatch(/^這個月加入資料到上限了，\d{1,2} 月 1 日恢復。/)
  })

  it('⛔ 上個月停的、排程沒再碰過那一份（關掉自動同步）：不再講先停', () => {
    const s = docToSourceSummary('s1', { failureKind: 'ai_budget', budgetPausedMonth: '200001' } as any)
    expect(s.pausedByBudget).toBe(false)
    expect(s.failureReason).toBeUndefined()
  })

  it('別種失敗照原話', () => {
    const s = docToSourceSummary('s1', { failureReason: '自動檢查失敗：403', status: 'failed' } as any)
    expect(s).toMatchObject({ pausedByBudget: false, failureReason: '自動檢查失敗：403' })
  })
})
