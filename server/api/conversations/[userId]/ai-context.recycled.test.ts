import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「命中知識」裡在回收桶的那幾條（`D-125`，2026-10-13）。
 *
 * 換新版之後，舊版那幾條進了回收桶——文件還在，以前兩支端點只看「在不在」，
 * 畫面照樣給「去修『X』」，點下去什麼都沒發生。釘住：回收桶的 exists=false（不給點）、標題照給；
 * 真的不在了沒有標題；別家的照舊當成不在。兩支端點（最近一次／那一則）同一套說法。
 */

let chunks: Record<string, Record<string, unknown>> = {}
let conversation: Record<string, unknown> | null = null
let turn: Record<string, unknown> | null = null

vi.mock('~~/server/utils/firebase', () => ({
  getDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (name === 'knowledgeChunks') return { exists: id in chunks, data: () => chunks[id] }
          if (name === 'conversations') return { exists: !!conversation, data: () => conversation }
          return { exists: false, data: () => undefined }
        },
        collection: () => ({ doc: () => ({ get: async () => ({ exists: !!turn, data: () => turn }) }) }),
      }),
    }),
  }),
}))
vi.mock('~~/server/utils/workspace-auth', () => ({ requireCapability: vi.fn(async () => ({ workspaceId: 'ws1' })) }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))
vi.mock('~~/server/utils/ai-feedback-events', () => ({ AI_FEEDBACK_EVENTS_COLLECTION: 'aiFeedbackEvents', aiFeedbackDocId: () => 'fb1' }))
vi.mock('~~/server/utils/ai-turns', () => ({ AI_TURNS_COLLECTION: 'aiTurns' }))
vi.mock('~~/server/utils/ai-settings', () => ({ getAiSettings: async () => ({ replyMode: 'auto' }) }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))
vi.stubGlobal('getRouterParam', (_e: unknown, key: string) => (key === 'turnId' ? 't1' : 'U123'))

const { default: aiContext } = await import('./ai-context.get')
const { default: aiTurn } = await import('./ai-turn/[turnId].get')
type Payload = { sources: Array<{ chunkId: string, title: string, exists: boolean }> }
const call = (h: unknown) => (h as (e: unknown) => Promise<Payload>)({})

const IDS = ['live', 'recycledNew', 'recycledOld', 'gone', 'other']

beforeEach(() => {
  chunks = {
    live: { workspaceId: 'ws1', title: '運費多少' },
    recycledNew: { workspaceId: 'ws1', title: '舊版退貨規定', isDeleted: true, deletedAt: { seconds: 1 } },
    recycledOld: { workspaceId: 'ws1', title: '舊版保固', deletedAt: { seconds: 1 } }, // 舊資料只有 deletedAt
    other: { workspaceId: 'ws2', title: '別家的' },
  }
  conversation = { workspaceId: 'ws1', aiMeta: { lastSourceChunkIds: IDS, lastDecision: 'answered', updatedAt: { seconds: 5 } } }
  turn = { workspaceId: 'ws1', sourceChunkIds: IDS, decision: 'answered' }
})

describe.each([['ai-context（最近一次）', aiContext], ['ai-turn（那一則）', aiTurn]])('%s：命中知識', (_name, handler) => {
  it('🔴 在回收桶的不給點（exists=false），但標題照給——看得出當時用了哪一條', async () => {
    const { sources } = await call(handler)
    const by = Object.fromEntries(sources.map(s => [s.chunkId, s]))
    expect(by.live).toEqual({ chunkId: 'live', title: '運費多少', exists: true })
    expect(by.recycledNew).toEqual({ chunkId: 'recycledNew', title: '舊版退貨規定', exists: false })
    expect(by.recycledOld).toEqual({ chunkId: 'recycledOld', title: '舊版保固', exists: false })
  })

  it('真的不在了、別家的：沒有標題也不給點（⛔ 不把別家的標題讀出去）', async () => {
    const { sources } = await call(handler)
    const by = Object.fromEntries(sources.map(s => [s.chunkId, s]))
    expect(by.gone).toEqual({ chunkId: 'gone', title: '', exists: false })
    expect(by.other).toEqual({ chunkId: 'other', title: '', exists: false })
  })
})
