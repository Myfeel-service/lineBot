/**
 * 網頁小改自動套用的記帳（`C-338`①）：重切那次以前有記，「只改措辭」的判官那次完全沒記。
 * 兩次都記進「整理知識庫」那桶、帶著實際模型。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./firebase', () => ({ getDb: () => ({}) }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))
vi.mock('./ai-knowledge-chunker', () => ({ chunkTextWithLlm: vi.fn() }))
vi.mock('./ai-knowledge-sources', () => ({ listChunksBySource: vi.fn() }))
vi.mock('./ai-knowledge-chunks', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-knowledge-chunks')>()),
  updateKnowledgeChunk: vi.fn(async () => ({ status: 'indexed' })),
}))
vi.mock('./ai-knowledge-resync', async importOriginal => ({
  ...(await importOriginal<typeof import('./ai-knowledge-resync')>()),
  judgeCosmeticRewrites: vi.fn(),
}))

const { tryAutoApplyMinorChange } = await import('./ai-knowledge-autoapply')
const { chunkTextWithLlm } = await import('./ai-knowledge-chunker')
const { listChunksBySource } = await import('./ai-knowledge-sources')
const { judgeCosmeticRewrites } = await import('./ai-knowledge-resync')
const { recordAiUsage } = await import('./ai-usage')

const FLASH = 'gemini-2.5-flash'
const oldCard = { id: 'a', title: '運費說明', content: '消費滿一千元即可享有免運費的優惠。', tags: [], status: 'indexed', isOverview: false }

beforeEach(() => {
  vi.mocked(recordAiUsage).mockClear()
  vi.mocked(listChunksBySource).mockResolvedValue([oldCard] as any)
  vi.mocked(chunkTextWithLlm).mockResolvedValue({
    chunks: [{ title: '運費說明', content: '只要消費滿一千元，就能享有免運費優惠。', tags: [], questions: [], sourceId: null }],
    inputTokens: 5000,
    outputTokens: 800,
    calls: [{ model: FLASH, inputTokens: 5000, outputTokens: 800 }],
  } as any)
})

describe('自動套用的記帳', () => {
  it('重切、判「只改措辭」兩次都記進整理知識庫那桶（判官那次以前完全沒記）', async () => {
    vi.mocked(judgeCosmeticRewrites).mockResolvedValue({
      verdicts: ['same_meaning'],
      inputTokens: 700,
      outputTokens: 40,
      calls: [{ model: FLASH, inputTokens: 700, outputTokens: 40 }],
    })
    const res = await tryAutoApplyMinorChange({} as any, 'src1', { workspaceId: 'ws1', name: '運費頁', generateOverview: false } as any, '只要消費滿一千元，就能享有免運費優惠。')
    expect(judgeCosmeticRewrites).toHaveBeenCalledTimes(1)
    expect(res.noop).toBe(true) // 判官說只是換句話說 → 不改卡
    const calls = vi.mocked(recordAiUsage).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(['ws1', {
      inputTokens: 5000, outputTokens: 800, importInputTokens: 5000, importOutputTokens: 800,
      modelTokens: { build: { flash: { input: 5000, output: 800 } } },
    }])
    expect(calls[1]).toEqual(['ws1', {
      inputTokens: 700, outputTokens: 40, importInputTokens: 700, importOutputTokens: 40,
      modelTokens: { build: { flash: { input: 700, output: 40 } } },
    }])
  })
})
