/**
 * 知識庫「要處理的事」（體檢）兩項跟著 `D-129` 改（2026-10-19 老闆「按你建議」）：
 *  ① 「有 N 條內容 AI 沒學起來」只數**自動重試用完**的——還在 5 次以內的系統會自己補好，列出來只會讓他以為要自己處理；
 *  ② 「有 N 份資料換了商品名，AI 還沒重新學」整項拿掉——改由排程自己補完（relearnPendingProductSources）。
 * 假資料庫在記憶體裡，正式庫零讀零寫。
 */
import { describe, expect, it, vi } from 'vitest'

const WS = 'ws1'
const STORE: Record<string, Record<string, Record<string, any>>> = {}

vi.mock('firebase-admin/firestore', () => ({ Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) } }))
vi.mock('~~/server/utils/workspace-auth', () => ({ requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'u' })) }))
vi.mock('~~/server/utils/ai-feedback-events', () => ({
  aggregateWrongAnswerMarks: () => new Map(),
  isChunkUnfixedSinceMark: () => false,
  readMarkDocsByReason: vi.fn(async () => ({ docs: [], truncated: false })),
  toWrongAnswerMarkEvent: (x: unknown) => x,
}))
vi.mock('~~/server/utils/ai-knowledge-sources', () => ({ KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources' }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  getWorkspaceProductNames: vi.fn(async () => []),
}))
vi.mock('~~/server/utils/ai-duplicate-scan', () => ({ KNOWLEDGE_DUP_SCANS_COLLECTION: 'knowledgeDupScans' }))
vi.mock('~~/server/utils/ai-knowledge-suggest', () => ({ KNOWLEDGE_SUGGESTIONS_COLLECTION: 'knowledgeSuggestions' }))
vi.mock('~~/server/utils/ai-product-alias', () => ({
  detectAliasCandidates: () => [],
  getProductAliases: vi.fn(async () => ({})),
}))
vi.mock('~~/server/utils/ai-knowledge-folders', () => ({
  listFolders: vi.fn(async () => Object.entries(STORE.knowledgeFolders ?? {}).map(([id, f]) => ({ id, ...f }))),
}))

function query(col: string, filters: Array<[string, unknown]> = []): any {
  return {
    where: (f: string, _op: string, v: unknown) => query(col, [...filters, [f, v]]),
    select: () => query(col, filters),
    limit: () => query(col, filters),
    count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
    doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
    get: async () => {
      const docs = Object.entries(STORE[col] ?? {})
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => ({ id, data: () => ({ ...d }) }))
      return { docs, size: docs.length }
    },
  }
}
const db: any = { collection: (col: string) => query(col) }
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)

const { default: handler } = await import('./health.get')
const run = () => (handler as (e: unknown) => Promise<any>)({})

describe('體檢跟著 `D-129` 改', () => {
  it('① 「AI 沒學起來」只數試完 5 次的：失敗 1～4 次（系統還在再試）不列', async () => {
    STORE.knowledgeSources = {}
    STORE.knowledgeChunks = {
      a: { workspaceId: WS, title: '還在再試', content: '內容夠長的一條知識內容內容內容內容內容', status: 'failed', retryCount: 1 },
      b: { workspaceId: WS, title: '也還在再試', content: '內容夠長的一條知識內容內容內容內容內容', status: 'failed', retryCount: 4 },
      c: { workspaceId: WS, title: '試完了', content: '內容夠長的一條知識內容內容內容內容內容', status: 'failed', retryCount: 5 },
      d: { workspaceId: WS, title: '手動又失敗', content: '內容夠長的一條知識內容內容內容內容內容', status: 'failed', retryCount: 6 },
    }
    const r = await run()
    expect(r.failedChunks.count).toBe(2)
    expect(r.failedChunks.items.map((i: { id: string }) => i.id).sort()).toEqual(['c', 'd'])
    // 還在再試的也⛔不能被算成「內容較短」
    expect(r.shortChunks.items.map((i: { id: string }) => i.id)).not.toContain('a')
  })

  it('② 「換了商品名、AI 還沒重新學」那一項不再回（排程自己補完）', async () => {
    STORE.knowledgeFolders = { f1: { workspaceId: WS, name: '小滑手', productSyncPending: true } }
    STORE.knowledgeSources = { s1: { workspaceId: WS, name: '說明書', folderId: 'f1', productName: '舊名字', productRelearnPending: true } }
    STORE.knowledgeChunks = {}
    const r = await run()
    expect(r).not.toHaveProperty('relearnPendingSources')
  })
})
