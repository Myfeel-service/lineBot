import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 重新同步「套用變更」要守方案知識量（`C-296` 審查 → `C-308`⑪ 改成跟加入同一個規矩）。
 *
 * 為什麼要守：匯入時空間不夠可以只收前幾條（批次匯入「收到滿為止」），可是之後按「重新同步」，
 * 沒收的那幾條會變成「新增」——不看額度就等於繞過方案上限。
 * 為什麼改：以前是「淨增加超過剩下的空間就整次 403」——覆蓋、刪除也一起不做，網頁上改了的價錢一條都沒更新。
 * 現在：先套刪除／覆蓋／保留，新增照順序建到滿為止，沒建的回 `quotaSkipped`、寫進操作紀錄，
 * 指紋不推進、「有變動」不清（網頁上有、知識庫沒有，推進了就再也比不出來）。
 * 正式庫零讀零寫：Firestore 全部換成記憶體裡的假物件。
 */

const WS = 'ws1'
const SRC = 'src1'
const LIMIT = { value: 3 as number | null }

type Card = { id: string, title: string, content: string, status: string, sourceId: string, workspaceId: string, deleted?: boolean }
let CARDS: Card[] = []
let SOURCE_UPDATES: Array<Record<string, unknown>> = []

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
  // 照真的規則數：不含回收桶、不含草稿
  getKnowledgeChunkQuota: vi.fn(async (ws: string) => ({
    used: CARDS.filter(c => c.workspaceId === ws && !c.deleted && c.status !== 'draft').length,
    limit: LIMIT.value,
    planName: '入門',
  })),
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
  collection: (col: string) => ({
    doc: (id: string) => ({
      update: async (data: Record<string, unknown>) => {
        if (col === 'knowledgeSources') {
          SOURCE_UPDATES.push(data)
          return
        }
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

const { createKnowledgeChunk, updateKnowledgeChunk } = await import('~~/server/utils/ai-knowledge-chunks')
const { invalidateKnowledgeChunkCount } = await import('~~/server/utils/ai-knowledge-quota')
const { clearSourceOutdated } = await import('~~/server/utils/ai-knowledge-sources')
const { writeAuditLog } = await import('~~/server/utils/audit-log')
const { default: handler } = await import('./resync-apply.post')
const call = () => (handler as unknown as (e: unknown) => Promise<any>)({})

const card = (id: string, status = 'indexed'): Card => ({ id, title: id, content: `${id} 的內容`, status, sourceId: SRC, workspaceId: WS })
const added = (id: string, content = `新的 ${id}`) => ({ id, kind: 'added', newChunk: { title: id, content, tags: [] } })
const removed = (c: Card) => ({ id: `rm-${c.id}`, kind: 'removed', oldChunk: { id: c.id, title: c.title, content: c.content, tags: [] } })
const modified = (c: Card) => ({ id: `mod-${c.id}`, kind: 'modified', oldChunk: { id: c.id, title: c.title, content: c.content, tags: [] }, newChunk: { title: c.title, content: `${c.content}（改過）`, tags: [] } })
const createdTitles = () => vi.mocked(createKnowledgeChunk).mock.calls.map(c => (c as any[])[1].title)
const lastSourceUpdate = () => SOURCE_UPDATES.at(-1)!

beforeEach(() => {
  vi.clearAllMocks()
  LIMIT.value = 3
  CARDS = [card('a'), card('b')]
  SOURCE_UPDATES = []
})

describe('resync-apply 的知識量：收到滿為止（`C-308`⑪）', () => {
  it('匯入時只收了 2 條、同步把沒收的 3 條當新增 → 照順序收到滿（1 條），其餘 2 條回 quotaSkipped，⛔ 不再整次 403', async () => {
    body = { entries: [added('c'), added('d'), added('e')], decisions: { c: 'add_new', d: 'add_new', e: 'add_new' }, contentHash: 'h-new' }
    const r = await call()
    expect(r).toMatchObject({ added: 1, quotaSkipped: 2, fingerprintAdvanced: false })
    expect(createdTitles()).toEqual(['c'])
    // 網頁上有、知識庫沒有：指紋不推進、「有變動」不清，空出位置再套一次才收得進來
    expect(lastSourceUpdate().contentHash).toBeUndefined()
    expect(lastSourceUpdate().appliedContentHash).toBeUndefined()
    expect(clearSourceOutdated).not.toHaveBeenCalled()
    // ⛔ 沒建的要寫進操作紀錄，不然只看到「新增 1」
    expect(vi.mocked(writeAuditLog).mock.calls[0]![0].note).toContain('還有 2 條新的沒有加進來')
  })

  it('⭐ 空間滿了，覆蓋（網頁改了價錢）照樣套用——以前整次 403，連改價都沒更新', async () => {
    LIMIT.value = 2
    const [a] = CARDS
    body = { entries: [added('c'), modified(a!)], decisions: { 'c': 'add_new', 'mod-a': 'use_new' } }
    const r = await call()
    expect(r).toMatchObject({ added: 0, updated: 1, quotaSkipped: 1 })
    expect(updateKnowledgeChunk).toHaveBeenCalledTimes(1)
    expect(createKnowledgeChunk).not.toHaveBeenCalled()
  })

  it('先刪再建：清單上新增排在刪除前面，刪掉的那一條空出的位置照樣給新增用', async () => {
    LIMIT.value = 2
    const [a] = CARDS
    body = { entries: [added('c'), removed(a!)], decisions: { c: 'add_new', [`rm-${a!.id}`]: 'delete_old' } }
    const r = await call()
    expect(r).toMatchObject({ added: 1, deleted: 1, quotaSkipped: 0 })
    expect(invalidateKnowledgeChunkCount).toHaveBeenCalledWith(WS) // 張數變了，額度快取要作廢
  })

  it('全部放得下：quotaSkipped＝0、照舊推進指紋、清掉「有變動」', async () => {
    const [a] = CARDS
    body = {
      entries: [added('c'), added('d'), removed(a!)],
      decisions: { c: 'add_new', d: 'add_new', [`rm-${a!.id}`]: 'delete_old' },
      contentHash: 'h-new',
    }
    await expect(call()).resolves.toMatchObject({ added: 2, deleted: 1, quotaSkipped: 0, fingerprintAdvanced: true })
    expect(lastSourceUpdate().contentHash).toBe('h-new')
    expect(clearSourceOutdated).toHaveBeenCalledTimes(1)
  })

  it('⛔ 刪掉草稿騰不出空間（草稿本來就沒算額度）', async () => {
    CARDS = [card('a'), card('b'), card('d1', 'draft'), card('d2', 'draft')]
    body = {
      entries: [added('c'), added('e'), removed(CARDS[2]!), removed(CARDS[3]!)],
      decisions: { 'c': 'add_new', 'e': 'add_new', 'rm-d1': 'delete_old', 'rm-d2': 'delete_old' },
    }
    // 2 條（正常）＋只剩 1 個位置；以前會把刪草稿算成騰出 2 條
    await expect(call()).resolves.toMatchObject({ added: 1, deleted: 2, quotaSkipped: 1 })
    expect(createdTitles()).toEqual(['c'])
  })

  it('內容不合格、等一下會被略過的新增不佔位置', async () => {
    LIMIT.value = 3
    body = { entries: [added('bad', ''), added('c')], decisions: { bad: 'add_new', c: 'add_new' } }
    await expect(call()).resolves.toMatchObject({ added: 1, quotaSkipped: 0 })
  })

  it('同一次套用逾時後重按（applyId 一樣）：上一次建好的是原地覆寫，⛔ 不再被自己的額度擋', async () => {
    body = { entries: [added('c')], decisions: { c: 'add_new' }, applyId: 'apply-1' }
    await expect(call()).resolves.toMatchObject({ added: 1, quotaSkipped: 0 }) // 3／3，滿了
    await expect(call()).resolves.toMatchObject({ added: 1, quotaSkipped: 0 }) // 重按：同一張覆寫
    expect(CARDS.filter(c => !c.deleted)).toHaveLength(3)
  })

  it('不限張數的方案全部建', async () => {
    LIMIT.value = null
    body = { entries: [added('c'), added('d'), added('e')], decisions: { c: 'add_new', d: 'add_new', e: 'add_new' } }
    await expect(call()).resolves.toMatchObject({ added: 3, quotaSkipped: 0 })
  })
})
