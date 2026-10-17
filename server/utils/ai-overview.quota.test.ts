/**
 * 自動重做總表時要看知識空間（2026-10-17 全站對過）。
 *
 * 試算表同步、網址套用改動之後會重做那一份的總表；以前「沒有總表就直接新建一張」不看空間，
 * 滿了照樣長出來，每份型錄可以多收 1 條。手動「做一張總表」的端點本來就有擋，這裡補的是自動那兩條路。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ai-knowledge-chunker', () => ({
  summarizeAsOverviewCard: vi.fn(async () => ({
    card: { title: '我們有賣什麼', content: 'A、B、C', tags: [], questions: [] },
    inputTokens: 10,
    outputTokens: 5,
  })),
}))
vi.mock('./ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  buildChunkSoftDeletePatch: () => ({}),
  createKnowledgeChunk: vi.fn(async () => {}),
  updateKnowledgeChunk: vi.fn(async () => {}),
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-knowledge-quota', () => ({
  assertKnowledgeChunkQuota: vi.fn(async () => {}),
  invalidateKnowledgeChunkCount: vi.fn(),
}))

const { regenerateOverviewCard } = await import('./ai-overview')
const { summarizeAsOverviewCard } = await import('./ai-knowledge-chunker')
const { createKnowledgeChunk, updateKnowledgeChunk } = await import('./ai-knowledge-chunks')
const { assertKnowledgeChunkQuota, invalidateKnowledgeChunkCount } = await import('./ai-knowledge-quota')

/** 假 Firestore：那一份資料底下的卡 */
function dbWith(cards: Array<Record<string, unknown>>) {
  const q: any = {
    where: () => q,
    get: async () => ({ docs: cards.map((c, i) => ({ id: `c${i}`, data: () => c })) }),
  }
  return { collection: () => q } as any
}
const child = (title: string) => ({ title, content: `${title} 的內容`, tags: [], status: 'indexed' })

beforeEach(() => vi.clearAllMocks())

describe('重做總表看空間', () => {
  it('沒有總表、空間也滿了 → 這輪不新建，⛔ 也不先花 AI 的錢', async () => {
    vi.mocked(assertKnowledgeChunkQuota).mockRejectedValueOnce(Object.assign(new Error('AI 知識量已達上限'), { statusCode: 403 }))
    const out = await regenerateOverviewCard(dbWith([child('A'), child('B'), child('C')]), 'ws1', 's1')
    expect(out).toBe('skipped')
    expect(summarizeAsOverviewCard).not.toHaveBeenCalled()
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
  })

  it('沒有總表、空間夠 → 新建一張，並作廢條數快取（緊接著的空間檢查才不會少算這一條）', async () => {
    const out = await regenerateOverviewCard(dbWith([child('A'), child('B')]), 'ws1', 's1')
    expect(out).toBe('created')
    expect(assertKnowledgeChunkQuota).toHaveBeenCalledWith('ws1', 1, expect.anything())
    expect(createKnowledgeChunk).toHaveBeenCalledTimes(1)
    expect(invalidateKnowledgeChunkCount).toHaveBeenCalledWith('ws1')
  })

  it('已經有總表 → 改那一張、不多佔空間，不必看空間', async () => {
    const out = await regenerateOverviewCard(
      dbWith([child('A'), child('B'), { isOverview: true, status: 'indexed', title: '舊總表' }]),
      'ws1',
      's1',
    )
    expect(out).toBe('updated')
    expect(assertKnowledgeChunkQuota).not.toHaveBeenCalled()
    expect(updateKnowledgeChunk).toHaveBeenCalledTimes(1)
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
  })

  it('不是空間的錯（例如讀不到資料庫）照樣往外丟，不要吞成「跳過」', async () => {
    vi.mocked(assertKnowledgeChunkQuota).mockRejectedValueOnce(new Error('firestore down'))
    await expect(regenerateOverviewCard(dbWith([child('A'), child('B')]), 'ws1', 's1')).rejects.toThrow('firestore down')
  })
})
