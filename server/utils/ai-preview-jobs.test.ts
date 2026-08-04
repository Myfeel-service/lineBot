import { beforeEach, describe, expect, it, vi } from 'vitest'

// LLM 切卡 / 總覽卡改成可控 mock（保留真的 segmentText / MAX_TOTAL_CHUNKS）
vi.mock('./ai-knowledge-chunker', async (importActual) => {
  const actual = await importActual<typeof import('./ai-knowledge-chunker')>()
  return { ...actual, chunkSegment: vi.fn(), summarizeAsOverviewCard: vi.fn(), enrichCardBatch: vi.fn() }
})
// 切頁與 OCR 改 mock，不碰真的 pdf-lib / Gemini
vi.mock('./pdf-split', () => ({
  splitPdfPageRange: vi.fn(async () => Buffer.from('sub-pdf')),
  getPdfPageCount: vi.fn(async () => 0),
}))
vi.mock('./ai-source-extractors', async (importActual) => {
  const actual = await importActual<typeof import('./ai-source-extractors')>()
  return { ...actual, ocrPdfWithGemini: vi.fn() }
})

import { advanceWork, CHUNK_PARALLEL, makeWork, progressFor, workToPreviewResult } from './ai-preview-jobs'
import { chunkSegment, ENRICH_BATCH_SIZE, enrichCardBatch, summarizeAsOverviewCard } from './ai-knowledge-chunker'
import { ocrPdfWithGemini } from './ai-source-extractors'

const mockChunk = vi.mocked(chunkSegment)
const mockOverview = vi.mocked(summarizeAsOverviewCard)
const mockOcr = vi.mocked(ocrPdfWithGemini)
const mockEnrich = vi.mocked(enrichCardBatch)

const card = (title: string) => ({ title, content: 'c', tags: [], questions: [], sourceId: null })

beforeEach(() => {
  mockChunk.mockReset()
  mockOverview.mockReset()
  mockOcr.mockReset()
  mockEnrich.mockReset()
})

describe('advanceWork — chunk 階段', () => {
  it('一輪並行切多段、累積 + 同 title 跨段去重，做完轉 finalize（無總覽卡）', async () => {
    mockChunk.mockImplementation(async (text: string) => ({
      chunks: [card(`T-${text}`), card('DUP')],
      inputTokens: 1,
      outputTokens: 2,
    }))
    const work = makeWork({ type: 'text', generateOverview: false })
    work.sourceName = 'doc'
    work.segments = ['seg1', 'seg2']
    work.phase = 'chunk'

    // 段數 ≤ CHUNK_PARALLEL → 一輪跑完（序列版要兩輪；長文件的來回次數是體感延遲主因）
    await advanceWork(work)
    expect(work.phase).toBe('finalize')
    expect(work.segmentCursor).toBe(2)
    // 結果仍照段序合併、跨段同名去重
    expect(work.chunks.map(c => c.title)).toEqual(['T-seg1', 'DUP', 'T-seg2'])
    expect(work.usage).toEqual({ inputTokens: 2, outputTokens: 4 })
    expect(mockChunk).toHaveBeenCalledTimes(2)
  })

  it('段數超過並行上限時分批推進（cursor 逐批前進，不會一次全吃）', async () => {
    mockChunk.mockImplementation(async (text: string) => ({
      chunks: [card(`T-${text}`)],
      inputTokens: 1,
      outputTokens: 1,
    }))
    const work = makeWork({ type: 'text', generateOverview: false })
    work.sourceName = 'doc'
    work.segments = Array.from({ length: CHUNK_PARALLEL + 2 }, (_, i) => `s${i}`)
    work.phase = 'chunk'

    await advanceWork(work)
    expect(work.segmentCursor).toBe(CHUNK_PARALLEL)
    expect(work.phase).toBe('chunk')

    await advanceWork(work)
    expect(work.segmentCursor).toBe(CHUNK_PARALLEL + 2)
    expect(work.phase).toBe('finalize')
    expect(work.chunks.length).toBe(CHUNK_PARALLEL + 2)
  })

  it('切卡撞輸出上限（截斷）→ 對半切原地換入、不進 cursor，下一輪用更小段重試', async () => {
    const truncErr = Object.assign(
      new Error('Gemini JSON parse failed: Unterminated string in JSON'),
      { statusMessage: 'Gemini JSON parse failed: Unterminated string in JSON' },
    )
    // 大段（>4000）截斷；切小後（≤4000）成功。用 call 計數給不同 title 避免去重誤消。
    let call = 0
    mockChunk.mockImplementation(async (text: string) => {
      if (text.length > 4000) throw truncErr
      call += 1
      return { chunks: [card(`T${call}`)], inputTokens: 1, outputTokens: 1 }
    })
    const work = makeWork({ type: 'text', generateOverview: false })
    work.sourceName = 'doc'
    work.segments = ['x\n'.repeat(3000)] // ~6000 字，可切、> MIN_SEGMENT_SPLIT_LEN
    work.phase = 'chunk'

    await advanceWork(work) // 截斷 → 切成 2 段
    expect(work.segmentCursor).toBe(0)
    expect(work.phase).toBe('chunk')
    expect(work.segments.length).toBe(2)

    await advanceWork(work) // 小段成功 → cursor 1
    await advanceWork(work) // 小段成功 → cursor 2 → finalize
    expect(work.phase).toBe('finalize')
    expect(work.chunks.length).toBe(2)
  })

  it('非截斷錯誤（如網路 502）不切，直接往外丟', async () => {
    mockChunk.mockRejectedValue(Object.assign(new Error('Gemini error: network error'), {
      statusMessage: 'Gemini error: network error',
    }))
    const work = makeWork({ type: 'text', generateOverview: false })
    work.sourceName = 'doc'
    work.segments = ['a\n'.repeat(3000)]
    work.phase = 'chunk'
    await expect(advanceWork(work)).rejects.toThrow(/network error/)
    expect(work.segments.length).toBe(1) // 沒被切
  })

  it('generateOverview 且卡≥2 → 切完轉 overview，再轉 finalize 並帶總覽卡', async () => {
    mockChunk.mockResolvedValue({ chunks: [card('A'), card('B')], inputTokens: 1, outputTokens: 1 })
    mockOverview.mockResolvedValue({
      card: { title: '總覽', content: 'c', tags: ['x'], questions: ['q'], sourceId: null, isOverview: true },
      inputTokens: 3,
      outputTokens: 4,
    })
    const work = makeWork({ type: 'text', generateOverview: true })
    work.sourceName = 'doc'
    work.segments = ['only']
    work.phase = 'chunk'

    await advanceWork(work)
    expect(work.phase).toBe('overview')

    await advanceWork(work)
    expect(work.phase).toBe('finalize')
    expect(work.overviewCard?.title).toBe('總覽')
    expect(work.usage).toEqual({ inputTokens: 4, outputTokens: 5 })
  })

  it('總覽卡合成失敗不擋，仍轉 finalize、overviewCard 保持 null', async () => {
    mockOverview.mockRejectedValue(new Error('boom'))
    const work = makeWork({ type: 'text', generateOverview: true })
    work.chunks = [card('A'), card('B')]
    work.phase = 'overview'

    await advanceWork(work)
    expect(work.phase).toBe('finalize')
    expect(work.overviewCard).toBeNull()
  })
})

describe('advanceWork — enrich 階段（一列一卡補問法）', () => {
  it('逐批補 questions/tags、只補空缺，做完 gsheet 轉 finalize', async () => {
    mockEnrich.mockImplementation(async cards => ({
      items: cards.map((_, i) => ({ questions: [`q-${i}`], tags: [`t-${i}`] })),
      inputTokens: 2,
      outputTokens: 3,
    }))
    const work = makeWork({ type: 'gsheet', generateOverview: false })
    work.chunks = Array.from({ length: ENRICH_BATCH_SIZE + 2 }, (_, i) => card(`C${i}`))
    // 商家已有問法的卡不該被覆蓋
    work.chunks[0]!.questions = ['既有問法']
    work.phase = 'enrich'

    await advanceWork(work)
    expect(work.phase).toBe('enrich')
    expect(work.enrichCursor).toBe(ENRICH_BATCH_SIZE)

    await advanceWork(work)
    expect(work.phase).toBe('finalize')
    expect(work.chunks[0]!.questions).toEqual(['既有問法']) // 已有的優先
    expect(work.chunks[1]!.questions).toEqual(['q-1'])
    expect(work.chunks[ENRICH_BATCH_SIZE]!.questions).toEqual(['q-0']) // 第二批第一張
    expect(work.usage).toEqual({ inputTokens: 4, outputTokens: 6 })
    expect(mockEnrich).toHaveBeenCalledTimes(2)
  })

  it('補問法失敗不擋匯入：跳過該批、cursor 照進，卡片保持沒問法', async () => {
    mockEnrich.mockRejectedValue(new Error('boom'))
    const work = makeWork({ type: 'gsheet', generateOverview: false })
    work.chunks = [card('A'), card('B')]
    work.phase = 'enrich'

    await advanceWork(work)
    expect(work.phase).toBe('finalize')
    expect(work.chunks.map(c => c.questions)).toEqual([[], []])
    expect(work.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('xlsx（file）要總覽卡：enrich 完轉 overview', async () => {
    mockEnrich.mockResolvedValue({
      items: [{ questions: ['q'], tags: [] }, { questions: ['q'], tags: [] }],
      inputTokens: 1,
      outputTokens: 1,
    })
    const work = makeWork({ type: 'file', generateOverview: true })
    work.chunks = [card('A'), card('B')]
    work.phase = 'enrich'

    await advanceWork(work)
    expect(work.phase).toBe('overview')
  })

  it('progressFor 在 enrich 階段回「補客人問法」進度', () => {
    const work = makeWork({ type: 'gsheet', generateOverview: false })
    work.chunks = [card('A'), card('B'), card('C')]
    work.phase = 'enrich'
    work.enrichCursor = 2
    expect(progressFor(work)).toEqual({ done: 2, total: 3, label: '補客人問法' })
  })
})

describe('advanceWork — ocr 階段（切頁批處理）', () => {
  it('每輪 OCR 一批頁、累積文字，做完轉 chunk 並標 ocrUsed', async () => {
    let n = 0
    mockOcr.mockImplementation(async () => {
      n += 1
      return { text: `page${n}`, rawLength: 5, meta: {}, inputTokens: 1, outputTokens: 1 }
    })
    const work = makeWork({ type: 'file', generateOverview: false })
    work.sourceName = 'scan.pdf'
    work.phase = 'ocr'
    work.ocrPageTotal = 12
    const deps = { getSourceBuffer: async () => Buffer.from('pdf') }

    await advanceWork(work, deps)
    expect(work.ocrPageCursor).toBe(5)
    expect(work.phase).toBe('ocr')

    await advanceWork(work, deps)
    expect(work.ocrPageCursor).toBe(10)
    expect(work.phase).toBe('ocr')

    await advanceWork(work, deps)
    expect(work.ocrPageCursor).toBe(12)
    expect(work.phase).toBe('chunk')
    expect(work.ocrUsed).toBe(true)
    expect(work.ocrText).toBe('page1\npage2\npage3')
    expect(work.segments.length).toBeGreaterThan(0)
    expect(work.usage).toEqual({ inputTokens: 3, outputTokens: 3 })
    expect(mockOcr).toHaveBeenCalledTimes(3)
  })
})

describe('progressFor / workToPreviewResult', () => {
  it('progressFor 依 phase 回進度', () => {
    const work = makeWork({ type: 'text', generateOverview: false })
    work.phase = 'chunk'
    work.segments = ['a', 'b', 'c']
    work.segmentCursor = 1
    // label 是給使用者看的進度字樣：原本叫「切卡」，全站統一改成白話的「整理」
    expect(progressFor(work)).toEqual({ done: 1, total: 3, label: '整理' })

    work.phase = 'ocr'
    work.ocrPageCursor = 5
    work.ocrPageTotal = 12
    expect(progressFor(work)).toEqual({ done: 5, total: 12, label: '辨識掃描檔' })
  })

  it('workToPreviewResult 形狀與舊 preview-chunks 一致', () => {
    const work = makeWork({ type: 'url', generateOverview: false })
    work.sourceName = 'x'
    work.sourceUrl = 'https://x'
    work.chunks = [card('A')]
    const res = workToPreviewResult(work)
    expect(res.sourceName).toBe('x')
    expect(res.sourceUrl).toBe('https://x')
    expect(res.chunks).toEqual([{ title: 'A', content: 'c', tags: [], questions: [] }])
    expect(res.overviewCard).toBeNull()
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})
