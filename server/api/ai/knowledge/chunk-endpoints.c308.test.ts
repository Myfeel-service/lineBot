import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 一條知識的編輯、解鎖、刪除、還原（`C-308`①②⑧、`D-125`②，2026-10-13）。
 *
 * ① 🔴 沒改也上鎖：按「儲存」一律寫 manuallyEditedAt——打開看一下沒改字按儲存，那一條從此不跟表格更新，
 *    操作紀錄還查不到（MYFEEL 10-13 中了 3 條）。現在什麼都沒變就什麼都不寫。
 * ② 解鎖不生效：同步看到表格沒變就整份跳過。試算表的要清掉那一份的指紋，並回 appliesOn 讓畫面講什麼時候生效。
 * ⑧ 刪除後「還剩幾條空間」最多 1 分鐘不更新。
 * D-125② 在後台刪掉試算表來的一條＝「這一列不要了」：記進那一份的 gsheetExcludedTitles；還原就拿掉。
 * 正式庫零讀零寫：Firestore 是記憶體裡的假物件。
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__ts__',
    delete: () => '__del__',
    arrayUnion: (...v: unknown[]) => ({ __op: 'arrayUnion', v }),
    arrayRemove: (...v: unknown[]) => ({ __op: 'arrayRemove', v }),
  },
  Timestamp: { fromMillis: (ms: number) => ({ __ts: ms, toMillis: () => ms }), fromDate: (d: Date) => ({ toMillis: () => d.getTime() }) },
}))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/audit-log', () => ({
  writeAuditLog: vi.fn(async () => {}),
  auditTimeText: (v: unknown) => (v == null ? null : String(v)),
}))
vi.mock('~~/server/utils/ai-knowledge-quota', async importOriginal => ({
  assertKnowledgeChunkQuota: vi.fn(async () => {}),
  invalidateKnowledgeChunkCount: vi.fn(),
  // 「算不算進空間」用真的那一把尺（還原時要靠它決定擋不擋）
  chunkCountsTowardQuota: (await importOriginal<typeof import('~~/server/utils/ai-knowledge-quota')>()).chunkCountsTowardQuota,
}))
vi.mock('~~/server/utils/ai-knowledge-chunks', async importOriginal => ({
  // 整理 body 那一套用真的（「沒改」要照同一套比），會寫庫、會算向量的換成假的
  ...(await importOriginal<typeof import('~~/server/utils/ai-knowledge-chunks')>()),
  updateKnowledgeChunk: vi.fn(async () => ({ status: 'indexed' })),
  invalidateTagIndexCache: vi.fn(),
  runIndexOnChunk: vi.fn(async (_db: unknown, id: string) => ({ id, status: 'indexed' })),
}))
vi.mock('~~/server/utils/ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  countSourceChunks: vi.fn(async () => 3),
}))

/** 假 Firestore：STORE[collection][id]；update 認得 arrayUnion／arrayRemove／delete 三種特殊值 */
const STORE: Record<string, Record<string, Record<string, any>>> = {}
const WRITES: Array<{ col: string, id: string, payload: Record<string, any> }> = []
function apply(doc: Record<string, any>, patch: Record<string, any>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && v.__op === 'arrayUnion') doc[k] = [...new Set([...(doc[k] ?? []), ...v.v])]
    else if (v && typeof v === 'object' && v.__op === 'arrayRemove') doc[k] = (doc[k] ?? []).filter((x: unknown) => !v.v.includes(x))
    else if (v === '__del__') delete doc[k]
    else doc[k] = v
  }
}
function docRef(col: string, id: string): any {
  return {
    id,
    get: async () => ({ id, exists: !!STORE[col]?.[id], data: () => STORE[col]?.[id] }),
    update: async (payload: Record<string, any>) => {
      if (!STORE[col]?.[id]) throw new Error('NOT_FOUND')
      WRITES.push({ col, id, payload })
      apply(STORE[col][id]!, payload)
    },
  }
}
const db: any = { collection: (col: string) => ({ doc: (id: string) => docRef(col, id) }) }
vi.mock('~~/server/utils/firebase', () => ({ getDb: () => db }))

let body: Record<string, unknown> = {}
let routeId = 'c1'
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('getRouterParam', () => routeId)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { updateKnowledgeChunk } = await import('~~/server/utils/ai-knowledge-chunks')
const { writeAuditLog } = await import('~~/server/utils/audit-log')
const { invalidateKnowledgeChunkCount, assertKnowledgeChunkQuota } = await import('~~/server/utils/ai-knowledge-quota')
const { default: putHandler } = await import('./[chunkId].put')
const { default: deleteHandler } = await import('./[chunkId].delete')
const { default: settingsHandler } = await import('./[chunkId]/settings.post')
const { default: restoreHandler } = await import('./[chunkId]/restore.post')
const run = (h: unknown) => (h as (e: unknown) => Promise<any>)({})
const lastAudit = () => (vi.mocked(writeAuditLog).mock.calls.at(-1)![0] as Record<string, any>)

const chunk = (extra: Record<string, any> = {}) => ({
  workspaceId: WS, sourceId: 's1', title: '出貨時間', content: '下單後 3 天出貨', tags: ['出貨'], questions: ['多久出貨？', '什麼時候寄？'],
  status: 'indexed', embedding: { v: 1 }, isDeleted: false, ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(STORE)) delete STORE[k]
  WRITES.length = 0
  routeId = 'c1'
  STORE.knowledgeChunks = { c1: chunk() }
  STORE.knowledgeSources = { s1: { workspaceId: WS, type: 'gsheet', name: '價目表', contentHash: 'h1' } }
})

describe('PUT：沒改就不鎖、不記（`C-308`①）', () => {
  it('打開看一下就按儲存（一字未改，連空白、問法順序不同都算沒改）→ 什麼都不寫、不鎖、回 changed:false', async () => {
    body = { title: ' 出貨時間 ', content: '下單後 3 天出貨\n', tags: ['出貨'], questions: ['什麼時候寄？', '多久出貨？'] }
    const r = await run(putHandler)
    expect(r).toMatchObject({ id: 'c1', changed: false, status: 'indexed', title: '出貨時間' })
    expect(updateKnowledgeChunk).not.toHaveBeenCalled()
    expect(writeAuditLog).not.toHaveBeenCalled()
    expect(WRITES).toHaveLength(0)
  })

  it('body 沒帶標籤＝不改標籤（以前會把標籤洗成空的）', async () => {
    body = { title: '出貨時間', content: '下單後 3 天出貨' }
    await expect(run(putHandler)).resolves.toMatchObject({ changed: false })
  })

  it('只改標籤 → 上鎖、記一筆「改了標籤」，不重學', async () => {
    body = { title: '出貨時間', content: '下單後 3 天出貨', tags: ['出貨', '物流'] }
    await expect(run(putHandler)).resolves.toMatchObject({ changed: true })
    expect(vi.mocked(updateKnowledgeChunk).mock.calls[0]![1]).toMatchObject({ manualEdit: true, contentChanged: false, tags: ['出貨', '物流'] })
    expect(lastAudit().note).toBe('出貨時間：改了標籤；之後不會跟著表格更新（可以在這條解除鎖定）')
  })

  it('只改客人問法 → 上鎖、記「改了客人問法，AI 會照新的內容再學一次」（問法也進學習內容）', async () => {
    body = { title: '出貨時間', content: '下單後 3 天出貨', tags: ['出貨'], questions: ['幾天會到？'] }
    await run(putHandler)
    expect(vi.mocked(updateKnowledgeChunk).mock.calls[0]![1]).toMatchObject({ manualEdit: true, questions: ['幾天會到？'] })
    // `D-129`：操作紀錄是店家看得到的字，不講「重新學習」
    expect(lastAudit().note).toContain('改了客人問法，AI 會照新的內容再學一次')
  })

  it('改了內容和標題 → 兩樣都講', async () => {
    body = { title: '出貨', content: '下單後 5 天出貨', tags: ['出貨'] }
    await run(putHandler)
    expect(vi.mocked(updateKnowledgeChunk).mock.calls[0]![1]).toMatchObject({ manualEdit: true, contentChanged: true })
    expect(lastAudit().note).toMatch(/^出貨：改了標題、內容，AI 會照新的內容再學一次/)
  })
})

describe('總覽只改「你寫的那段」（`C-369`）', () => {
  const ov = (extra: Record<string, any> = {}) => chunk({
    title: '商品總覽', isOverview: true, overviewAuto: '重點：家電（除濕機）\n\n我們賣家電。', ownerNote: '舊的介紹',
    content: '重點：家電（除濕機）\n\n我們賣家電。\n\n舊的介紹', manuallyEditedAt: null, ...extra,
  })

  it('改你寫的那段 → 內容＝系統那段＋新的話、⛔ 不上鎖（商品清單照樣跟著資料更新）', async () => {
    STORE.knowledgeChunks = { c1: ov() }
    body = { title: '商品總覽', ownerNote: '客服請找 LINE 官方帳號。' }
    await expect(run(putHandler)).resolves.toMatchObject({ changed: true })
    expect(vi.mocked(updateKnowledgeChunk).mock.calls[0]![1]).toMatchObject({
      manualEdit: false,
      contentChanged: true,
      content: '重點：家電（除濕機）\n\n我們賣家電。\n\n客服請找 LINE 官方帳號。',
    })
    expect(STORE.knowledgeChunks.c1!.ownerNote).toBe('客服請找 LINE 官方帳號。')
    expect(lastAudit().note).toBe('商品總覽：改了你寫的介紹，AI 會照新的內容再學一次；商品清單照樣跟著資料更新')
  })

  it('整張改（不是只改你寫的那段）→ 照手改上鎖、拿掉兩段記號（下次資料更新再拆）', async () => {
    STORE.knowledgeChunks = { c1: ov() }
    body = { title: '商品總覽', content: '我自己寫的整張總覽' }
    await run(putHandler)
    expect(vi.mocked(updateKnowledgeChunk).mock.calls[0]![1]).toMatchObject({ manualEdit: true })
    expect(STORE.knowledgeChunks.c1!.ownerNote).toBeUndefined()
    expect(STORE.knowledgeChunks.c1!.overviewAuto).toBeUndefined()
  })

  it('還沒拆過的舊總覽帶 ownerNote 來 → 不認（照一般知識改：body 沒內容就擋）', async () => {
    STORE.knowledgeChunks = { c1: ov({ overviewAuto: undefined, ownerNote: undefined }) }
    body = { title: '商品總覽', ownerNote: '想補的話' }
    await expect(run(putHandler)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('解除鎖定要真的生效（`C-308`②）', () => {
  it('試算表：清掉那一份的指紋（下一次同步整份比對）、回 appliesOn=next_sync、記一筆', async () => {
    STORE.knowledgeChunks!.c1!.manuallyEditedAt = '__ts__'
    body = { clearManualLock: true }
    const r = await run(settingsHandler)
    expect(r.appliesOn).toBe('next_sync')
    expect(STORE.knowledgeChunks!.c1!.manuallyEditedAt).toBeNull()
    expect(STORE.knowledgeSources!.s1!.contentHash).toBe('')
    // ⚠️ 先解鎖再清指紋（反過來中間跑一輪同步會把指紋寫回去、這條又被當鎖著）
    const order = WRITES.map(w => w.col)
    expect(order.indexOf('knowledgeChunks')).toBeLessThan(order.indexOf('knowledgeSources'))
    expect(lastAudit().note).toBe('出貨時間：解除了鎖定，下一次同步會換回表格上的內容')
  })

  it.each([
    ['url', 'next_change'],
    ['file', 'next_replace'],
    ['manual', 'never'],
  ])('%s 的資料 → appliesOn=%s，⛔ 不動那一份的指紋', async (type, expected) => {
    STORE.knowledgeSources!.s1!.type = type
    body = { clearManualLock: true }
    await expect(run(settingsHandler)).resolves.toMatchObject({ appliesOn: expected })
    expect(STORE.knowledgeSources!.s1!.contentHash).toBe('h1')
  })

  it('沒帶 clearManualLock 的設定 → 不回 appliesOn', async () => {
    body = { enabled: false }
    const r = await run(settingsHandler)
    expect(r.appliesOn).toBeUndefined()
  })

  it('錯誤訊息講「條」、叫人按「再試一次」（`D-129`：停用又沒學成的那一條，編輯框上那顆就叫這個名字）', async () => {
    STORE.knowledgeChunks!.c1!.embedding = null
    STORE.knowledgeChunks!.c1!.status = 'disabled'
    body = { enabled: true }
    await expect(run(settingsHandler)).rejects.toMatchObject({ statusMessage: '這條知識 AI 還沒學會，請先按上面的「再試一次」' })
  })
})

describe('在後台刪掉試算表來的一條（`D-125`②、`C-308`⑧）', () => {
  it('記進那一份的「不再收」名單、紀錄講出來、空間快取馬上作廢', async () => {
    await run(deleteHandler)
    expect(STORE.knowledgeChunks!.c1!.isDeleted).toBe(true)
    expect(STORE.knowledgeSources!.s1!.gsheetExcludedTitles).toEqual(['出貨時間'])
    expect(lastAudit().note).toContain('試算表上這一列之後不會再收')
    expect(invalidateKnowledgeChunkCount).toHaveBeenCalledWith(WS)
    // ⛔ 先記名單再刪：記不成就整個不刪，免得重按時已在回收桶、名單永遠沒記上
    const order = WRITES.map(w => `${w.col}/${w.id}`)
    expect(order.indexOf('knowledgeSources/s1')).toBeLessThan(order.indexOf('knowledgeChunks/c1'))
  })

  it('⛔ 不是試算表、或是總覽那一條 → 不記名單（空間快取照樣作廢）', async () => {
    STORE.knowledgeSources!.s1!.type = 'file'
    await run(deleteHandler)
    expect(STORE.knowledgeSources!.s1!.gsheetExcludedTitles).toBeUndefined()
    expect(lastAudit().note).not.toContain('不會再收')
    expect(invalidateKnowledgeChunkCount).toHaveBeenCalledWith(WS)

    STORE.knowledgeSources!.s1!.type = 'gsheet'
    STORE.knowledgeChunks!.ov = chunk({ title: '我們有賣什麼', isOverview: true })
    routeId = 'ov'
    await run(deleteHandler)
    expect(STORE.knowledgeSources!.s1!.gsheetExcludedTitles).toBeUndefined()
  })

  it('從回收桶還原 → 從名單拿掉（照比對 key，大小寫、空白不同也認得）', async () => {
    STORE.knowledgeChunks!.c1 = chunk({ isDeleted: true, deletedAt: '__ts__', status: 'disabled', statusBeforeDelete: 'indexed' })
    STORE.knowledgeSources!.s1!.gsheetExcludedTitles = ['出貨 時間', '別的那一列']
    await run(restoreHandler)
    expect(STORE.knowledgeSources!.s1!.gsheetExcludedTitles).toEqual(['別的那一列'])
    expect(STORE.knowledgeChunks!.c1!.isDeleted).toBe(false)
  })
})

describe('從回收桶還原要不要看空間（2026-10-17 全站對過）', () => {
  it('還原一般的卡 → 會佔一條空間，照樣先檢查', async () => {
    STORE.knowledgeChunks!.c1 = chunk({ isDeleted: true, deletedAt: '__ts__', status: 'disabled', statusBeforeDelete: 'indexed' })
    await run(restoreHandler)
    expect(assertKnowledgeChunkQuota).toHaveBeenCalledWith(WS, 1, expect.anything())
  })

  it('還原「等你看過」的 → 回來還是草稿、不佔空間，⛔ 不可以因為空間滿了救不回來', async () => {
    STORE.knowledgeChunks!.c1 = chunk({ isDeleted: true, deletedAt: '__ts__', status: 'disabled', statusBeforeDelete: 'draft' })
    await run(restoreHandler)
    expect(assertKnowledgeChunkQuota).not.toHaveBeenCalled()
    expect(STORE.knowledgeChunks!.c1!.status).toBe('draft')
    expect(STORE.knowledgeChunks!.c1!.isDeleted).toBe(false)
  })
})
