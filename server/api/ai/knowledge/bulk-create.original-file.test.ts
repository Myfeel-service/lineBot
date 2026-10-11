import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 匯入時把原檔留下來（`C-296`③）。
 *  · 整理工作要是**這個帳號的**才複製——importId 是前端帶的，不能拿別家的工作來複製。
 *  · 留存失敗不擋匯入（卡片才是主角）。
 *  · 「更新這一份」卻留存失敗：舊版原檔一起清掉，⛔ 不讓人下載到跟現在的知識對不上的舊版。
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/ai-usage', () => ({
  assertMaintenanceBudget: vi.fn(async () => {}),
  recordAiUsage: vi.fn(async () => {}),
}))
vi.mock('~~/server/utils/ai-knowledge-quota', () => ({
  assertKnowledgeChunkQuota: vi.fn(async () => {}),
  invalidateKnowledgeChunkCount: vi.fn(),
}))
vi.mock('~~/server/utils/ai-knowledge-sources', () => ({
  countSourceChunks: vi.fn(async () => 0),
  countSourceQuotaChunks: vi.fn(async () => 0),
  recycleSourceChunks: vi.fn(async () => 3),
  invalidateCatalogSourceCache: vi.fn(),
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
}))
vi.mock('~~/server/utils/ai-knowledge-folder-guard', () => ({ resolveKnowledgeFolderId: vi.fn(async () => null) }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  addWorkspaceProductName: vi.fn(),
  createKnowledgeChunk: vi.fn(async (_db: unknown, o: { chunkId: string }) => ({ id: o.chunkId, status: 'indexed', embeddingTokens: 1 })),
  normalizeChunkInput: (raw: any) => ({ title: String(raw?.title ?? ''), content: String(raw?.content ?? ''), tags: [], questions: [], sourceId: null, isOverview: false }),
  validateChunkInput: () => null,
}))
vi.mock('~~/server/utils/ai-preview-jobs', () => ({
  KNOWLEDGE_PREVIEW_JOBS_COLLECTION: 'knowledgePreviewJobs',
  loadSourceFile: vi.fn(async () => Buffer.from('docx-bytes')),
}))
vi.mock('~~/server/utils/knowledge-source-files', () => ({
  keepOriginalFile: vi.fn(async (o: any) => ({ filePath: `knowledge-files/${o.workspaceId}/${o.sourceId}/original.${o.ext}`, fileName: o.fileName, fileSize: 10, fileContentType: o.contentType })),
  deleteSourceFiles: vi.fn(async () => {}),
}))

/** 假 Firestore：工作文件從 JOBS 讀、既有來源從 SOURCES 讀，來源的寫入記在 writes */
const JOBS: Record<string, Record<string, unknown>> = {
  jobMine: { workspaceId: WS, sourceFile: 'source.docx' },
  jobTheirs: { workspaceId: 'ws2', sourceFile: 'source.docx' },
  jobNoFile: { workspaceId: WS, sourceFile: null },
}
const SOURCES: Record<string, Record<string, unknown>> = {
  srcOld: { workspaceId: WS, type: 'file', name: 'W1 使用說明書' },
}
const writes: Array<{ col: string, id: string, op: string, data: any }> = []
const db: any = {
  collection: (col: string) => ({
    doc: (id: string) => {
      const docs = col === 'knowledgePreviewJobs' ? JOBS : col === 'knowledgeSources' ? SOURCES : {}
      return {
        get: async () => ({ id, exists: !!docs[id], data: () => docs[id] }),
        set: async (data: any) => { writes.push({ col, id, op: 'set', data }) },
        update: async (data: any) => { writes.push({ col, id, op: 'update', data }) },
      }
    },
  }),
  getAll: async (...refs: any[]) => refs.map(() => ({ exists: false, data: () => undefined })),
}
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { keepOriginalFile, deleteSourceFiles } = await import('~~/server/utils/knowledge-source-files')
const { default: handler } = await import('./bulk-create.post')
const call = () => (handler as unknown as (e: unknown) => Promise<any>)({})
const fileUpdate = () => writes.find(w => w.col === 'knowledgeSources' && w.op === 'update' && w.data.filePath)

beforeEach(() => {
  vi.clearAllMocks()
  writes.length = 0
})

const importBody = (importId: string, extra: Record<string, unknown> = {}) => ({
  source: { type: 'file', name: 'W1 使用說明書', fileName: 'W1 使用說明書', ...extra },
  chunks: [{ title: '保固', content: '一年' }],
  importId,
})

describe('bulk-create 留原檔', () => {
  it('自己帳號的工作 → 複製原檔、資料記下路徑與檔名；檔名沒副檔名會補上（下載才打得開）', async () => {
    body = importBody('jobMine')
    await expect(call()).resolves.toMatchObject({ indexed: 1 })
    expect(vi.mocked(keepOriginalFile).mock.calls[0]![0]).toMatchObject({ workspaceId: WS, ext: 'docx', fileName: 'W1 使用說明書.docx' })
    // 記下是哪一筆匯入留的：同一筆重送時看到它就不再複製（見 bulk-create.retry.test）
    expect(fileUpdate()?.data).toMatchObject({ fileName: 'W1 使用說明書.docx', fileSize: 10, fileImportId: 'jobMine' })
    expect(fileUpdate()?.data.filePath).toMatch(new RegExp(`^knowledge-files/${WS}/`))
  })

  it('⛔ 別家帳號的工作 → 不複製（importId 是前端帶的）', async () => {
    body = importBody('jobTheirs')
    await expect(call()).resolves.toMatchObject({ indexed: 1 })
    expect(keepOriginalFile).not.toHaveBeenCalled()
    expect(fileUpdate()).toBeUndefined()
  })

  it('「更新這一份」但這次沒有原檔可留 → 舊版原檔一起清掉', async () => {
    body = { ...importBody('jobNoFile'), replaceSourceId: 'srcOld' }
    await expect(call()).resolves.toMatchObject({ indexed: 1 })
    expect(deleteSourceFiles).toHaveBeenCalledWith(WS, 'srcOld')
  })

  it('留存本身失敗 → 匯入照樣成功（卡片才是主角）', async () => {
    vi.mocked(keepOriginalFile).mockRejectedValueOnce(new Error('storage down'))
    body = importBody('jobMine')
    await expect(call()).resolves.toMatchObject({ indexed: 1, failed: 0 })
  })
})
