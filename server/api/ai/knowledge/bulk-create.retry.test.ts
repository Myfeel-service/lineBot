import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 匯入逾時後「同一包再送一次」要安全（`C-296` 審查）。
 *
 * 批次匯入在 502／504／408／斷線時會用同一包（同一個 importId）自動再送一次——
 * 第一次可能其實做完了，只是閘道先逾時。再送一次 ⛔ 不可以：
 *  · 多建一批卡、多一份資料；
 *  · 把剛建好的卡當成新的再算一次額度（剛好收到滿的那一批，重送一定被自己擋成「知識量不夠」）；
 *  · 「更新這一份」時把剛建好的新卡當舊卡收進回收桶；
 *  · 重新留原檔——整理工作那份暫存可能已經清掉，複製失敗會把剛留好的原檔刪掉。
 * 正式庫零讀零寫：Firestore 是記憶體裡的假物件，額度照真的規則數（不含回收桶、不含草稿）。
 */

const WS = 'ws1'
const LIMIT = { value: 3 }

/** 假 Firestore：STORE[collection][id] */
const STORE: Record<string, Record<string, Record<string, any>>> = {}
const failNext = { importDoneUpdate: false }

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/ai-usage', () => ({
  assertMaintenanceBudget: vi.fn(async () => {}),
  recordAiUsage: vi.fn(async () => {}),
}))

const liveChunks = (pred: (d: Record<string, any>) => boolean) =>
  Object.values(STORE.knowledgeChunks ?? {}).filter(d => d.isDeleted !== true && pred(d))

vi.mock('~~/server/utils/ai-knowledge-quota', () => ({
  // 照真的規則：現有（不含回收桶、不含草稿）＋這批 > 上限就 403
  assertKnowledgeChunkQuota: vi.fn(async (ws: string, adding: number) => {
    if (adding <= 0) return
    const used = liveChunks(d => d.workspaceId === ws && d.status !== 'draft').length
    if (used + adding > LIMIT.value) {
      throw Object.assign(new Error(`AI 知識量不夠了：目前 ${used} 條，這批要再加 ${adding} 條`), { statusCode: 403 })
    }
  }),
  invalidateKnowledgeChunkCount: vi.fn(),
}))
vi.mock('~~/server/utils/ai-knowledge-sources', () => ({
  countSourceChunks: vi.fn(async (_db: unknown, ws: string, sid: string) => liveChunks(d => d.workspaceId === ws && d.sourceId === sid).length),
  countSourceQuotaChunks: vi.fn(async (_db: unknown, ws: string, sid: string) => liveChunks(d => d.workspaceId === ws && d.sourceId === sid && d.status !== 'draft').length),
  recycleSourceChunks: vi.fn(async (_db: unknown, ws: string, sid: string) => {
    const live = liveChunks(d => d.workspaceId === ws && d.sourceId === sid)
    for (const d of live) Object.assign(d, { isDeleted: true, status: 'disabled' })
    return live.length
  }),
  invalidateCatalogSourceCache: vi.fn(),
}))
vi.mock('~~/server/utils/ai-knowledge-folder-guard', () => ({ resolveKnowledgeFolderId: vi.fn(async () => null) }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  addWorkspaceProductName: vi.fn(),
  // 建卡＝覆寫同一個 id 的文件（跟真的 ref.set 一樣，不是合併）
  createKnowledgeChunk: vi.fn(async (_db: unknown, o: any) => {
    STORE.knowledgeChunks ??= {}
    STORE.knowledgeChunks[o.chunkId] = { workspaceId: o.workspaceId, sourceId: o.sourceId, title: o.title, status: 'indexed', isDeleted: false }
    return { id: o.chunkId, status: 'indexed', embeddingTokens: 1 }
  }),
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

function docRef(col: string, id: string) {
  return {
    id,
    col,
    get: async () => ({ id, exists: !!STORE[col]?.[id], data: () => STORE[col]?.[id] }),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      STORE[col] ??= {}
      STORE[col][id] = opts?.merge ? { ...(STORE[col][id] ?? {}), ...data } : { ...data }
    },
    update: async (data: Record<string, unknown>) => {
      if (col === 'knowledgeSources' && 'importDone' in data && failNext.importDoneUpdate) {
        failNext.importDoneUpdate = false
        throw new Error('deadline exceeded')
      }
      if (!STORE[col]?.[id]) throw new Error('NOT_FOUND')
      Object.assign(STORE[col][id]!, data)
    },
  }
}
const db: any = {
  collection: (col: string) => ({ doc: (id: string) => docRef(col, id) }),
  getAll: async (...refs: Array<ReturnType<typeof docRef>>) => Promise.all(refs.map(r => r.get())),
}
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { createKnowledgeChunk } = await import('~~/server/utils/ai-knowledge-chunks')
const { recycleSourceChunks } = await import('~~/server/utils/ai-knowledge-sources')
const { keepOriginalFile, deleteSourceFiles } = await import('~~/server/utils/knowledge-source-files')
const { assertMaintenanceBudget } = await import('~~/server/utils/ai-usage')
const { default: handler } = await import('./bulk-create.post')

const call = () => (handler as unknown as (e: unknown) => Promise<any>)({})
const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `第 ${i + 1} 條`, content: `內容 ${i + 1}` }))
const fileImport = (importId: string, extra: Record<string, unknown> = {}) => ({
  source: { type: 'file', name: '說明書.docx', fileName: '說明書.docx' },
  chunks: cards(3),
  importId,
  ...extra,
})
const sourceCount = () => Object.keys(STORE.knowledgeSources ?? {}).length
const aliveIds = () => liveChunks(() => true).map(d => d.title).sort()

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
  LIMIT.value = 3
  failNext.importDoneUpdate = false
  STORE.knowledgePreviewJobs = { job1: { workspaceId: WS, sourceFile: 'source.docx' }, job2: { workspaceId: WS, sourceFile: 'source.docx' } }
})

describe('bulk-create：逾時後同一包再送一次', () => {
  it('第一次其實做完了 → 重送回同一份結果，⛔ 不重建卡、不重算額度（收到剛好滿也不會被自己擋）、不重留原檔', async () => {
    body = fileImport('job1')
    const first = await call()
    expect(first).toMatchObject({ total: 3, indexed: 3, failed: 0, originalKept: true, alreadyImported: false })

    // 額度剛好滿（3／3）：以前重送會被「目前 3 條，這批要再加 3 條」擋成 403
    const again = await call()
    expect(again).toMatchObject({
      sourceId: first.sourceId,
      total: 3,
      indexed: 3,
      failed: 0,
      replacedChunks: 0,
      originalKept: true,
      alreadyImported: true,
    })
    expect(again.items.map((i: any) => i.id)).toEqual(first.items.map((i: any) => i.id))
    expect(again.items.every((i: any) => i.status === 'indexed')).toBe(true)

    expect(createKnowledgeChunk).toHaveBeenCalledTimes(3) // 只有第一次
    expect(keepOriginalFile).toHaveBeenCalledTimes(1)
    expect(deleteSourceFiles).not.toHaveBeenCalled()
    expect(sourceCount()).toBe(1)
    expect(aliveIds()).toHaveLength(3)
    // 重送不碰維運額度：第一次剛記的 embedding 用量不該反過來擋住重送
    expect(assertMaintenanceBudget).toHaveBeenCalledTimes(1)
  })

  it('「更新這一份」做完後重送 → ⛔ 不把剛建好的新卡收進回收桶，被蓋掉的舊卡張數跟第一次一樣', async () => {
    STORE.knowledgeSources = { srcOld: { workspaceId: WS, type: 'file', name: '說明書.docx', isDeleted: false } }
    STORE.knowledgeChunks = {
      old1: { workspaceId: WS, sourceId: 'srcOld', title: '舊 1', status: 'indexed', isDeleted: false },
      old2: { workspaceId: WS, sourceId: 'srcOld', title: '舊 2', status: 'indexed', isDeleted: false },
    }
    body = fileImport('job2', { replaceSourceId: 'srcOld' })
    const first = await call()
    expect(first).toMatchObject({ sourceId: 'srcOld', replacedChunks: 2 })

    const again = await call()
    expect(again).toMatchObject({ sourceId: 'srcOld', replacedChunks: 2, alreadyImported: true })
    expect(recycleSourceChunks).toHaveBeenCalledTimes(1)
    expect(aliveIds()).toEqual(['第 1 條', '第 2 條', '第 3 條'])
  })

  it('第一次做到最後一步才斷（「做完了」沒記上）→ 重送接著做：額度不重算、卡原地覆寫、原檔不重留也不被刪', async () => {
    body = fileImport('job1')
    failNext.importDoneUpdate = true
    await call() // 卡都建好了、原檔也留了，只有最後那筆記號沒寫成

    // 整理工作的暫存已經清掉：要是重送又去複製，複製失敗就會走「清掉原檔」那條路
    delete STORE.knowledgePreviewJobs!.job1
    const again = await call()
    expect(again).toMatchObject({ total: 3, indexed: 3, originalKept: true, alreadyImported: false })
    expect(sourceCount()).toBe(1)
    expect(aliveIds()).toHaveLength(3) // 覆寫同一批，不是 6 張
    expect(keepOriginalFile).toHaveBeenCalledTimes(1)
    expect(deleteSourceFiles).not.toHaveBeenCalled()
    const src = Object.values(STORE.knowledgeSources!)[0]!
    expect(src.filePath).toMatch(/^knowledge-files\/ws1\//) // 原檔路徑沒被重置成空的
    expect(src.importDone).toMatchObject({ total: 3, indexed: 3 })
  })

  it('「更新這一份」做到一半斷了 → 重送不再收一次舊卡（收的會是自己的新卡），被蓋掉的張數沿用第一次', async () => {
    STORE.knowledgeSources = { srcOld: { workspaceId: WS, type: 'file', name: '說明書.docx', isDeleted: false } }
    STORE.knowledgeChunks = { old1: { workspaceId: WS, sourceId: 'srcOld', title: '舊 1', status: 'indexed', isDeleted: false } }
    body = fileImport('job2', { replaceSourceId: 'srcOld' })
    failNext.importDoneUpdate = true
    await call()

    const again = await call()
    expect(again).toMatchObject({ replacedChunks: 1, alreadyImported: false })
    expect(recycleSourceChunks).toHaveBeenCalledTimes(1)
    expect(aliveIds()).toEqual(['第 1 條', '第 2 條', '第 3 條'])
  })

  it('同一個 importId 但內容不一樣 → 不是重送，照一般匯入重做（不拿上一次的結果搪塞）', async () => {
    LIMIT.value = 10
    body = fileImport('job1')
    await call()
    body = fileImport('job1', { chunks: [{ title: '第 1 條', content: '改過的內容' }] })
    const again = await call()
    expect(again).toMatchObject({ total: 1, alreadyImported: false })
    expect(createKnowledgeChunk).toHaveBeenCalledTimes(4)
  })

  it('沒帶 importId 的匯入一律照做（舊版前端），不會被當成重送', async () => {
    LIMIT.value = 10
    body = { source: { type: 'text', name: '貼上的文字' }, chunks: cards(2) }
    await call()
    const again = await call()
    expect(again).toMatchObject({ alreadyImported: false })
    expect(sourceCount()).toBe(2)
  })
})
