import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 重新同步「套用變更」要守方案知識量（`C-296` 審查）。
 *
 * 為什麼要有：匯入時空間不夠可以只收前幾條（批次匯入「收到滿為止」），可是之後按「重新同步」，
 * 沒收的那幾條會變成「新增」——以前照建不誤，等於繞過方案上限。
 * 算的是**淨增加**：新增 +1、刪除 −1（⛔ 草稿除外，草稿本來就沒算額度）、覆蓋／保留不變；
 * 同一次套用重按（applyId 一樣）時，上一次建好的那張是原地覆寫、不算新增。
 * 正式庫零讀零寫：Firestore 全部換成記憶體裡的假物件。
 */

const WS = 'ws1'
const SRC = 'src1'
const LIMIT = { value: 3 }

type Card = { id: string, title: string, content: string, status: string, sourceId: string, workspaceId: string, deleted?: boolean }
let CARDS: Card[] = []

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' } }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/ai-usage', () => ({ assertMaintenanceBudget: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-overview', () => ({ regenerateOverviewCard: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-knowledge-resync', () => ({
  countDivergentKeeps: () => 0,
  loadDiffExemptIds: async () => new Set<string>(),
}))
vi.mock('~~/server/utils/ai-knowledge-quota', async importOriginal => ({
  // 「算不算額度」那一把尺用真的（chunkCountsTowardQuota），其餘假造
  ...(await importOriginal<typeof import('~~/server/utils/ai-knowledge-quota')>()),
  // 照真的規則：現有（不含回收桶、不含草稿）＋這批 > 上限就 403
  assertKnowledgeChunkQuota: vi.fn(async (ws: string, adding: number) => {
    if (adding <= 0) return
    const used = CARDS.filter(c => c.workspaceId === ws && !c.deleted && c.status !== 'draft').length
    if (used + adding > LIMIT.value) {
      throw Object.assign(new Error(`AI 知識量不夠了：目前 ${used} 條，這批要再加 ${adding} 條`), { statusCode: 403 })
    }
  }),
  invalidateKnowledgeChunkCount: vi.fn(),
}))
vi.mock('~~/server/utils/ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  getSource: vi.fn(async () => ({ id: SRC, data: { workspaceId: WS, type: 'url', name: '官網 FAQ', status: 'ready' } })),
  listChunksBySource: vi.fn(async (_db: unknown, ws: string, sid: string) =>
    CARDS.filter(c => c.workspaceId === ws && c.sourceId === sid && !c.deleted).map(c => ({ ...c, isOverview: false }))),
  countSourceChunks: vi.fn(async () => CARDS.filter(c => !c.deleted).length),
  clearSourceOutdated: vi.fn(async () => {}),
  buildSourceClearFailure: () => ({}),
}))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  buildChunkSoftDeletePatch: () => ({ isDeleted: true }),
  createKnowledgeChunk: vi.fn(async (_db: unknown, o: any) => {
    CARDS = CARDS.filter(c => c.id !== o.chunkId) // 同一個 id＝覆寫
    CARDS.push({ id: o.chunkId, title: o.title, content: o.content, status: 'indexed', sourceId: o.sourceId, workspaceId: o.workspaceId })
    return { id: o.chunkId, status: 'indexed', embeddingTokens: 1 }
  }),
  updateKnowledgeChunk: vi.fn(async () => ({ status: 'indexed' })),
  normalizeChunkInput: (raw: any) => ({ title: String(raw?.title ?? '').trim(), content: String(raw?.content ?? '').trim(), tags: [], questions: [] }),
  validateChunkInput: (i: { content: string }) => (i.content ? null : '請輸入內容'),
}))

const db: any = {
  collection: () => ({
    doc: (id: string) => ({
      update: async (data: Record<string, unknown>) => {
        const c = CARDS.find(x => x.id === id)
        if (c && data.isDeleted === true) c.deleted = true
      },
    }),
  }),
}
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('getRouterParam', () => SRC)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { createKnowledgeChunk } = await import('~~/server/utils/ai-knowledge-chunks')
const { invalidateKnowledgeChunkCount } = await import('~~/server/utils/ai-knowledge-quota')
const { default: handler } = await import('./resync-apply.post')
const call = () => (handler as unknown as (e: unknown) => Promise<any>)({})

const card = (id: string, status = 'indexed'): Card => ({ id, title: id, content: `${id} 的內容`, status, sourceId: SRC, workspaceId: WS })
const added = (id: string, content = `新的 ${id}`) => ({ id, kind: 'added', newChunk: { title: id, content, tags: [] } })
const removed = (c: Card) => ({ id: `rm-${c.id}`, kind: 'removed', oldChunk: { id: c.id, title: c.title, content: c.content, tags: [] } })

beforeEach(() => {
  vi.clearAllMocks()
  LIMIT.value = 3
  CARDS = [card('a'), card('b')]
})

describe('resync-apply 的知識量檢查', () => {
  it('⛔ 匯入時只收了 2 條（空間只剩這些），同步把沒收的 3 條當新增加回來 → 403，一張都不建', async () => {
    body = { entries: [added('c'), added('d'), added('e')], decisions: { c: 'add_new', d: 'add_new', e: 'add_new' } }
    await expect(call()).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('這批要再加 3 條') })
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
  })

  it('算的是淨增加：加 2 條、刪 1 條＝多 1 條，剛好放得下', async () => {
    const [a] = CARDS
    body = {
      entries: [added('c'), added('d'), removed(a!)],
      decisions: { c: 'add_new', d: 'add_new', [`rm-${a!.id}`]: 'delete_old' },
    }
    await expect(call()).resolves.toMatchObject({ added: 2, deleted: 1 })
    expect(invalidateKnowledgeChunkCount).toHaveBeenCalledWith(WS) // 張數變了，額度快取要作廢
  })

  it('⛔ 刪掉草稿騰不出空間（草稿本來就沒算額度）', async () => {
    CARDS = [card('a'), card('b'), card('d1', 'draft'), card('d2', 'draft')]
    body = {
      entries: [added('c'), added('e'), removed(CARDS[2]!), removed(CARDS[3]!)],
      decisions: { 'c': 'add_new', 'e': 'add_new', 'rm-d1': 'delete_old', 'rm-d2': 'delete_old' },
    }
    // 2 條（正常）＋ 2 條新增 ＝ 4 > 3；以前會把刪草稿算成騰出 2 條
    await expect(call()).rejects.toMatchObject({ statusCode: 403 })
  })

  it('內容不合格、等一下會被略過的新增不算', async () => {
    body = { entries: [added('c'), added('bad', '')], decisions: { c: 'add_new', bad: 'add_new' } }
    await expect(call()).resolves.toMatchObject({ added: 1 })
  })

  it('同一次套用逾時後重按（applyId 一樣）：上一次建好的是原地覆寫，⛔ 不再被自己的額度擋', async () => {
    body = { entries: [added('c')], decisions: { c: 'add_new' }, applyId: 'apply-1' }
    await expect(call()).resolves.toMatchObject({ added: 1 }) // 3／3，滿了
    await expect(call()).resolves.toMatchObject({ added: 1 }) // 重按：同一張覆寫
    expect(CARDS.filter(c => !c.deleted)).toHaveLength(3)
  })
})
