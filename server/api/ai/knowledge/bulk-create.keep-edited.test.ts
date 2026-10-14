import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 換新版時沿用他改過的那幾條（`D-125`①，2026-10-13 拍板 A）。
 *
 * 以前：換新版把他手動改過的那幾條一起丟進回收桶，沒提醒——說明裡卻一再講「你親手改過的一律保留」。
 * 現在：畫面先列出改過的、預設全勾，勾的帶在 `source.keepEditedChunkIds`：
 *  · ⛔ 不信前端：一條條驗（這一份的、還活著、真的改過），不合的安靜略過；
 *  · 沿用的不進回收桶；新版裡同名的那一條不收（不然同一件事兩條）；
 *  · 額度：沿用的照樣佔位置，騰出來的空間要扣掉；
 *  · 重送（逾時後同一包再送）回同樣的數字、⛔ 不把沿用的收進回收桶；重跑照上一次記下的名單。
 * 正式庫零讀零寫：Firestore 是記憶體裡的假物件，額度照真的規則數（不含回收桶、不含草稿）。
 */

const WS = 'ws1'
const LIMIT = { value: 10 }
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

vi.mock('~~/server/utils/ai-knowledge-quota', async importOriginal => ({
  ...(await importOriginal<typeof import('~~/server/utils/ai-knowledge-quota')>()),
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
  // 跟真的一樣照 keepIds 跳過（真的那一支另有 ai-knowledge-sources.dedupe.test.ts 釘）
  recycleSourceChunks: vi.fn(async (_db: unknown, ws: string, sid: string, opts: { keepIds?: Iterable<string> } = {}) => {
    const keep = new Set(opts.keepIds ?? [])
    const live = Object.entries(STORE.knowledgeChunks ?? {})
      .filter(([id, d]) => d.isDeleted !== true && d.workspaceId === ws && d.sourceId === sid && !keep.has(id))
    for (const [, d] of live) Object.assign(d, { isDeleted: true, status: 'disabled' })
    return live.length
  }),
  invalidateCatalogSourceCache: vi.fn(),
}))
vi.mock('~~/server/utils/ai-knowledge-folder-guard', () => ({ resolveKnowledgeFolderId: vi.fn(async () => null) }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  addWorkspaceProductName: vi.fn(),
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
  loadSourceFile: vi.fn(async () => Buffer.from('bytes')),
}))
vi.mock('~~/server/utils/knowledge-source-files', () => ({
  keepOriginalFile: vi.fn(async () => null),
  deleteSourceFiles: vi.fn(async () => {}),
}))

function docRef(col: string, id: string) {
  return {
    id,
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

const { recycleSourceChunks } = await import('~~/server/utils/ai-knowledge-sources')
const { writeAuditLog } = await import('~~/server/utils/audit-log')
const { default: handler } = await import('./bulk-create.post')
const call = () => (handler as unknown as (e: unknown) => Promise<any>)({})
const liveTitles = () => liveChunks(d => d.workspaceId === WS && d.sourceId === 'srcOld').map(d => d.title).sort()

const replaceWith = (titles: string[], keep: unknown[], extra: Record<string, unknown> = {}) => ({
  source: { type: 'file', name: '說明書.pdf', keepEditedChunkIds: keep },
  chunks: titles.map(t => ({ title: t, content: `${t} 的新內容` })),
  replaceSourceId: 'srcOld',
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
  LIMIT.value = 10
  failNext.importDoneUpdate = false
  STORE.knowledgeSources = {
    srcOld: { workspaceId: WS, type: 'file', name: '說明書.pdf', isDeleted: false },
    srcOther: { workspaceId: WS, type: 'file', name: '別份.pdf', isDeleted: false },
  }
  STORE.knowledgeChunks = {
    old1: { workspaceId: WS, sourceId: 'srcOld', title: '保固', status: 'indexed', isDeleted: false },
    // 他改過的
    old2: { workspaceId: WS, sourceId: 'srcOld', title: '出貨 時間', status: 'indexed', isDeleted: false, manuallyEditedAt: '__ts__' },
    old3: { workspaceId: WS, sourceId: 'srcOld', title: '尺寸', status: 'indexed', isDeleted: false },
    // 驗不過的：別份的、在回收桶的、別家的
    otherSrc: { workspaceId: WS, sourceId: 'srcOther', title: '別份', status: 'indexed', isDeleted: false, manuallyEditedAt: '__ts__' },
    binned: { workspaceId: WS, sourceId: 'srcOld', title: '舊的', status: 'disabled', isDeleted: true, deletedAt: '__ts__', manuallyEditedAt: '__ts__' },
    theirs: { workspaceId: 'ws2', sourceId: 'srcOld', title: '別家', status: 'indexed', isDeleted: false, manuallyEditedAt: '__ts__' },
  }
})

describe('換新版時沿用他改過的', () => {
  it('勾的那條留在原地、新版裡同名的不收；沒改過／別份／回收桶／別家／壞編號都安靜略過', async () => {
    body = replaceWith(['保固', '出貨時間', '尺寸', '顏色'], ['old2', 'old3', 'otherSrc', 'binned', 'theirs', '../x', 42])
    const r = await call()
    expect(r).toMatchObject({ keptEdited: 1, skippedForKept: 1, total: 3, replacedChunks: 2 })
    expect(vi.mocked(recycleSourceChunks).mock.calls[0]![3]).toEqual({ keepIds: ['old2'] })
    // 他改過的那一條還在（不是新版的「出貨時間」）、沒改過的換成新版
    expect(STORE.knowledgeChunks!.old2!.isDeleted).toBe(false)
    expect(liveTitles()).toEqual(['保固', '出貨 時間', '尺寸', '顏色'])
    expect(STORE.knowledgeChunks!.otherSrc!.isDeleted).toBe(false)
    expect(vi.mocked(writeAuditLog).mock.calls[0]![0].note).toContain('你改過的 1 條沿用原本的內容（新版裡同名的 1 條沒有收）')
  })

  it('⛔ 額度：沿用的照樣佔位置——滿的時候換一份 3 條的新版（都不同名）要擋', async () => {
    LIMIT.value = 3 // 現在 3 條（old1、old2、old3），換完會是 old2＋3 條新的＝4 條
    body = replaceWith(['A', 'B', 'C'], ['old2'])
    await expect(call()).rejects.toMatchObject({ statusCode: 403 })
    expect(recycleSourceChunks).not.toHaveBeenCalled()
  })

  it('新版裡同名的那條不收，所以剛好放得下', async () => {
    LIMIT.value = 3 // 換完＝old2＋「保固」「尺寸」＝3 條
    body = replaceWith(['保固', '出貨時間', '尺寸'], ['old2'])
    await expect(call()).resolves.toMatchObject({ keptEdited: 1, skippedForKept: 1, total: 2 })
    expect(liveTitles()).toHaveLength(3)
  })

  it('沒帶要更新的那一份（新建一份）→ keepEditedChunkIds 不管', async () => {
    body = { source: { type: 'file', name: '新的.pdf', keepEditedChunkIds: ['old2'] }, chunks: [{ title: '出貨時間', content: 'x' }] }
    await expect(call()).resolves.toMatchObject({ keptEdited: 0, skippedForKept: 0, total: 1 })
  })

  it('逾時後同一包再送 → 回同樣的數字，⛔ 不把沿用的那條收進回收桶', async () => {
    body = replaceWith(['保固', '出貨時間', '尺寸'], ['old2'], { importId: 'job1' })
    const first = await call()
    const again = await call()
    expect(again).toMatchObject({ alreadyImported: true, keptEdited: first.keptEdited, skippedForKept: first.skippedForKept })
    expect(again.keptEdited).toBe(1)
    expect(recycleSourceChunks).toHaveBeenCalledTimes(1)
    expect(STORE.knowledgeChunks!.old2!.isDeleted).toBe(false)
  })

  it('做到一半斷了、重跑時 body 不一樣 → 照上一次記下的名單：沿用的還是那條、不重收、同名的照樣不建', async () => {
    body = replaceWith(['保固', '出貨時間', '尺寸'], ['old2'], { importId: 'job1' })
    failNext.importDoneUpdate = true
    await call()
    expect(STORE.knowledgeSources!.srcOld!.importKeptEdited).toEqual(['old2'])

    body = replaceWith(['保固', '出貨時間', '尺寸', '顏色'], [], { importId: 'job1' })
    const again = await call()
    expect(again).toMatchObject({ alreadyImported: false, keptEdited: 1, skippedForKept: 1, replacedChunks: 2 })
    expect(recycleSourceChunks).toHaveBeenCalledTimes(1)
    expect(STORE.knowledgeChunks!.old2!.isDeleted).toBe(false)
    expect(liveTitles()).toEqual(['保固', '出貨 時間', '尺寸', '顏色'])
  })
})
