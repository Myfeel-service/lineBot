import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 複製推播（`C-293`）的承諾：
 *   ① **原樣複製存好的那一份**：好幾則、圖片都一則不少（編輯器只認得第一則，從畫面重組會默默掉）
 *   ② 複製品是一則全新草稿：排程、快照、發送結果、當時送出去的那一份一律不帶
 *   ③ 節慶記號不帶（帶了會把複製品算進錯的那一檔）
 *   ④ 別家的推播複製不到，而且回 404 不是 403（不洩漏它存在）
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'u-copier' })),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'bc-src')
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(o.statusMessage ?? 'e'), o))

const { default: handler } = await import('./duplicate.post')
const { getDb } = await import('~~/server/utils/firebase')
const { writeAuditLog } = await import('~~/server/utils/audit-log')

/** 一則發完的推播：兩則訊息（第二則是圖）、有節慶記號、有發送結果與留存內容 */
const SENT = {
  workspaceId: WS,
  name: '中秋快樂',
  status: 'completed',
  channel: 'line',
  audienceSource: { type: 'tags', tagIds: ['t-vip'] },
  audienceSnapshot: { filter: null, resolvedUserIds: ['U1', 'U2'], estimatedCount: 2 },
  messages: [
    { type: 'text', text: '中秋節快樂！' },
    { type: 'image', originalContentUrl: 'https://x/a.jpg', previewImageUrl: 'https://x/a.jpg' },
  ],
  completionTagIds: ['t-got-midautumn'],
  festivalId: 'midautumn-2026',
  sentContent: { kind: 'module', moduleId: 'm1', moduleName: '中秋', messages: [], lineMessageCount: 1 },
  scheduleAt: '2026-09-25T02:00:00Z',
  startedAt: 'x',
  completedAt: 'y',
  totalCount: 2,
  sentCount: 2,
  failedCount: 0,
  skippedCount: 0,
  createdBy: 'u-original',
}

let written: Array<{ id: string, data: Record<string, unknown> }> = []
function givenSource(doc: Record<string, unknown> | null) {
  written = []
  vi.mocked(getDb).mockReturnValue({
    collection: () => ({
      doc: (id: string) => ({
        get: async () => ({ exists: !!doc, data: () => doc }),
        set: async (data: Record<string, unknown>) => { written.push({ id, data }) },
      }),
    }),
  } as never)
}
const run = () => (handler as (e: unknown) => Promise<Record<string, any>>)({})

beforeEach(() => {
  vi.mocked(writeAuditLog).mockClear()
})

describe('POST /api/broadcast/:id/duplicate', () => {
  it('① 訊息原樣複製（兩則、含圖片一則不少），對象、發完貼的記號都帶過去', async () => {
    givenSource(SENT)
    const res = await run()
    expect(written).toHaveLength(1)
    const doc = written[0]!.data
    expect(written[0]!.id).not.toBe('bc-src')
    expect(res.id).toBe(written[0]!.id)
    expect(doc.name).toBe('中秋快樂 (複製)')
    expect(doc.messages).toEqual(SENT.messages)
    expect(doc.audienceSource).toEqual({ type: 'tags', tagIds: ['t-vip'] })
    expect(doc.completionTagIds).toEqual(['t-got-midautumn'])
  })

  it('② 複製品是全新草稿：狀態、排程、快照、統計、留存內容、建立者都不沿用', async () => {
    givenSource(SENT)
    await run()
    const doc = written[0]!.data
    expect(doc).toMatchObject({
      workspaceId: WS,
      status: 'draft',
      scheduleAt: null,
      startedAt: null,
      completedAt: null,
      totalCount: 0,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      audienceSnapshot: { filter: null, resolvedUserIds: [], estimatedCount: 0 },
      createdBy: 'u-copier',
    })
    expect(doc).not.toHaveProperty('sentContent')
  })

  it('③ 節慶記號不帶', async () => {
    givenSource(SENT)
    await run()
    expect(written[0]!.data).not.toHaveProperty('festivalId')
  })

  it('④ 別家的推播：404，什麼都不寫', async () => {
    givenSource({ ...SENT, workspaceId: 'other-ws' })
    await expect(run()).rejects.toMatchObject({ statusCode: 404 })
    expect(written).toEqual([])
  })

  it('不存在：404', async () => {
    givenSource(null)
    await expect(run()).rejects.toMatchObject({ statusCode: 404 })
    expect(written).toEqual([])
  })

  it('沒有內容的舊資料：400 講清楚，不建一則空草稿', async () => {
    givenSource({ ...SENT, messages: [] })
    await expect(run()).rejects.toMatchObject({ statusCode: 400 })
    expect(written).toEqual([])
  })

  it('操作紀錄記下從哪一則複製來的', async () => {
    givenSource(SENT)
    await run()
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'broadcast.duplicate',
        targetId: written[0]!.id,
        note: '中秋快樂',
        after: expect.objectContaining({ name: '中秋快樂 (複製)', copiedFromId: 'bc-src' }),
      }),
      expect.anything(),
    )
  })
})
