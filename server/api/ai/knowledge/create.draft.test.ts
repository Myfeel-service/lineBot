import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 建卡端點的 `draft: true`（`D-109`：小幫手「補一張知識卡」只放進「等你看過」）。
 *
 * 🔴 這條路一走錯就是「沒看過就上線」：小幫手的確認卡寫著「還不會拿來回答客人」，
 *    端點卻建成一般卡＝客人馬上收到一段沒人審過的回答。
 * 另外兩件：待審卡先不吃額度（採用時才算，跟開帳讀網站的待審卡同一套）；
 *    只認 `true`——其他值一律當一般卡，不可以讓一張卡意外變成沒人會去看的待審。
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
}))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({
  addWorkspaceProductName: vi.fn(async () => {}),
  createKnowledgeChunk: vi.fn(async (_db: unknown, o: { chunkId: string, draft?: boolean }) => ({
    id: o.chunkId,
    status: o.draft ? 'draft' : 'indexed',
    embeddingTokens: 1,
  })),
  normalizeChunkInput: (raw: any) => ({
    title: String(raw?.title ?? ''),
    content: String(raw?.content ?? ''),
    tags: [],
    questions: [],
    sourceId: null,
    isOverview: false,
  }),
  validateChunkInput: () => null,
}))
vi.mock('~~/server/utils/ai-knowledge-sources', () => ({
  getSource: vi.fn(async () => null),
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
}))
vi.mock('~~/server/utils/ai-knowledge-folder-guard', () => ({
  resolveKnowledgeFolderId: vi.fn(async () => null),
}))
vi.mock('~~/server/utils/ai-knowledge-quota', () => ({
  assertKnowledgeChunkQuota: vi.fn(async () => {}),
  invalidateKnowledgeChunkCount: vi.fn(),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { getDb } = await import('~~/server/utils/firebase')
const { createKnowledgeChunk } = await import('~~/server/utils/ai-knowledge-chunks')
const { assertKnowledgeChunkQuota } = await import('~~/server/utils/ai-knowledge-quota')
const { writeAuditLog } = await import('~~/server/utils/audit-log')
const { default: createHandler } = await import('./create.post')

const db: any = { collection: () => ({ doc: () => ({ set: async () => {} }) }) }
const call = () => (createHandler as unknown as (e: unknown) => Promise<any>)({})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getDb).mockReturnValue(db)
})

describe('POST /api/ai/knowledge/create 的 draft', () => {
  it('draft:true → 建成「等你看過」、先不檢查額度、操作紀錄照實寫還沒上線', async () => {
    body = { title: '有沒有停車位', content: '門口有 3 格', draft: true }
    await expect(call()).resolves.toMatchObject({ status: 'draft' })
    expect(vi.mocked(createKnowledgeChunk).mock.calls[0]![1]).toMatchObject({ draft: true })
    expect(assertKnowledgeChunkQuota).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog).mock.calls[0]![0]).toMatchObject({
      after: { cardStatus: 'draft' },
      note: expect.stringContaining('還沒對客人上線'),
    })
  })

  it('沒帶 draft → 一般建卡：照樣擋額度、建出去就上線（既有行為不變）', async () => {
    body = { title: 't', content: 'c' }
    await expect(call()).resolves.toMatchObject({ status: 'indexed' })
    expect(vi.mocked(createKnowledgeChunk).mock.calls[0]![1]).toMatchObject({ draft: false })
    expect(assertKnowledgeChunkQuota).toHaveBeenCalledTimes(1)
  })

  it('⛔ 只認 true：字串 "true"、1 都當一般卡（寧可多擋一次額度，也不讓卡意外變成沒人看的待審）', async () => {
    for (const v of ['true', 1, 'yes']) {
      vi.clearAllMocks()
      vi.mocked(getDb).mockReturnValue(db)
      body = { title: 't', content: 'c', draft: v }
      await call()
      expect(vi.mocked(createKnowledgeChunk).mock.calls[0]![1]).toMatchObject({ draft: false })
      expect(assertKnowledgeChunkQuota).toHaveBeenCalledTimes(1)
    }
  })
})
