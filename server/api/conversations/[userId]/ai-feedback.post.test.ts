import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lineUserFirestoreDocId } from '~~/shared/line-workspace'

/**
 * 「這題 AI 答錯了」先問錯在哪（`D-135`，2026-10-18）。
 *
 * 以前一按就記、不問原因，還把當時撈到的每一條都列成「正在答錯客人」——正式站標過的 3 次都不是卡寫錯。
 * 釘住：答錯一定要帶原因；只有「資料寫錯」能選是哪一條、而且只能選這次撈到的；記下那一條當下的內容指紋與誰標的。
 */

const WS = 'ws1'
const CONV = lineUserFirestoreDocId('U123', WS)

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'agent-1' })),
}))
vi.mock('~~/server/utils/ai-turns', () => ({ AI_TURNS_COLLECTION: 'aiTurns' }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('~~/server/utils/ai-feedback-events', async orig => ({
  ...(await orig<typeof import('~~/server/utils/ai-feedback-events')>()),
  logAiFeedbackEvent: vi.fn(async () => {}),
}))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'U123')
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./ai-feedback.post')
const { getDb } = await import('~~/server/utils/firebase')
const { logAiFeedbackEvent, chunkContentFingerprint } = await import('~~/server/utils/ai-feedback-events')

const CHUNKS: Record<string, Record<string, unknown>> = {
  shipA: { workspaceId: WS, content: '小滑手第二批 11/20 出貨' },
  shipB: { workspaceId: WS, content: '電淨艙現貨，付款後 3 天內出貨' },
  theirs: { workspaceId: 'ws2', content: '別家的' },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getDb).mockReturnValue({
    collection: (col: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (col === 'conversations') return { exists: id === CONV, data: () => ({ workspaceId: WS }) }
          if (col === 'knowledgeChunks') return { exists: id in CHUNKS, data: () => CHUNKS[id] }
          return { exists: false, data: () => undefined }
        },
        collection: () => ({
          doc: () => ({
            get: async () => ({
              exists: true,
              data: () => ({ workspaceId: WS, query: '何時出貨', sourceChunkIds: ['shipA', 'shipB', 'theirs'] }),
            }),
          }),
        }),
      }),
    }),
  } as never)
})

const call = () => (handler as unknown as (e: unknown) => Promise<unknown>)({})
const logged = () => vi.mocked(logAiFeedbackEvent).mock.calls[0]?.[1]

describe('POST /api/conversations/:userId/ai-feedback：答錯先問錯在哪', () => {
  it('🔴 答錯沒帶原因 → 400、不記（還開著舊畫面的分頁送來的也擋）', async () => {
    body = { type: 'wrong_answer', turnId: 't1' }
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })
    body = { type: 'wrong_answer', turnId: 't1', reason: 'oops' }
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })
    expect(logAiFeedbackEvent).not.toHaveBeenCalled()
  })

  it('帶原因就記：原因、誰標的都存下來；沒選是哪一條就不存 pickedChunks', async () => {
    body = { type: 'wrong_answer', turnId: 't1', reason: 'wrong_product' }
    await expect(call()).resolves.toEqual({ ok: true })
    expect(logged()).toMatchObject({ type: 'wrong_answer', reason: 'wrong_product', markedBy: 'agent-1', turnId: 't1' })
    expect(logged()).not.toHaveProperty('pickedChunks')
  })

  it('資料寫錯＋選了是哪一條 → 只存那一條，帶標記當下的內容指紋', async () => {
    body = { type: 'wrong_answer', turnId: 't1', reason: 'wrong_data', chunkId: 'shipA' }
    await call()
    expect(logged()?.pickedChunks).toEqual([{ chunkId: 'shipA', contentHash: chunkContentFingerprint(CHUNKS.shipA!.content) }])
  })

  it('🔴 選的不是這次撈到的那幾條 → 400（不能借這支把任意一條標成寫錯）', async () => {
    body = { type: 'wrong_answer', turnId: 't1', reason: 'wrong_data', chunkId: 'notCited' }
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })
    expect(logAiFeedbackEvent).not.toHaveBeenCalled()
  })

  it('🔴 別的原因帶了 chunkId → 400（只有「資料寫錯」才選是哪一條）', async () => {
    body = { type: 'wrong_answer', turnId: 't1', reason: 'missing', chunkId: 'shipA' }
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })
  })

  it('別家的那一條（撈到了但讀不到是自己的）→ 標記照記、但不列進待辦（不存 pickedChunks）', async () => {
    body = { type: 'wrong_answer', turnId: 't1', reason: 'wrong_data', chunkId: 'theirs' }
    await expect(call()).resolves.toEqual({ ok: true })
    expect(logged()).toMatchObject({ reason: 'wrong_data' })
    expect(logged()).not.toHaveProperty('pickedChunks')
  })

  it('採用草稿不用帶原因', async () => {
    body = { type: 'draft_applied', turnId: 't1' }
    await expect(call()).resolves.toEqual({ ok: true })
    expect(logged()).not.toHaveProperty('reason')
  })
})
