/**
 * 兩個「看漏了」的病（`C-296` 審查）：
 *  ① 同名偵測把回收桶裡的資料也列出來 → 批次匯入問「要不要更新這一份」，按下去等於把它從回收桶救回來；
 *  ② 孤兒上傳檔只看照名稱排前 300 個 → 前面被還沒滿 24 小時（或刪不掉）的檔佔滿時，後面的永遠輪不到。
 * 正式庫零讀零寫：Firestore 與 Storage 都是記憶體裡的假物件。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
  Timestamp: { now: () => ({ __ts: 'now' }), fromMillis: (ms: number) => ({ __ts: ms }) },
}))

/** 假 bucket：物件照名稱排序；getFiles 照真的規則處理 prefix／startOffset（含）／maxResults／pageToken */
interface FakeObject { name: string, timeCreated: string, failDelete?: boolean }
let objects: FakeObject[] = []
const listCalls: Array<Record<string, unknown>> = []
const fakeBucket = {
  getFiles: async (q: { prefix?: string, startOffset?: string, maxResults?: number, pageToken?: string }) => {
    listCalls.push({ ...q })
    const sorted = objects
      .filter(o => !q.prefix || o.name.startsWith(q.prefix))
      .filter(o => !q.startOffset || o.name >= q.startOffset)
      .sort((a, b) => (a.name < b.name ? -1 : 1))
    const from = Number(q.pageToken ?? 0)
    const page = sorted.slice(from, from + (q.maxResults ?? 1000))
    const next = from + page.length < sorted.length ? { ...q, pageToken: String(from + page.length) } : null
    return [
      page.map(o => ({
        name: o.name,
        metadata: { timeCreated: o.timeCreated },
        delete: async () => {
          if (o.failDelete) throw new Error('permission denied')
          objects = objects.filter(x => x !== o)
        },
      })),
      next,
    ]
  },
}
vi.mock('./firebase', () => ({
  getDb: () => { throw new Error('test 必須自帶 db') },
  getStorage: () => ({ bucket: () => fakeBucket }),
}))
vi.mock('./ai-knowledge-chunker', () => ({
  chunkSegment: vi.fn(),
  summarizeAsOverviewCard: vi.fn(),
  enrichCardBatch: vi.fn(),
  segmentText: (t: string) => [t],
  MAX_TOTAL_CHUNKS: 150,
  ENRICH_BATCH_SIZE: 15,
  isChunkTruncationError: () => false,
  splitSegmentInHalf: (t: string) => [t, t],
}))
vi.mock('./pdf-split', () => ({ splitPdfPageRange: vi.fn(), getPdfPageCount: vi.fn() }))
vi.mock('./ai-source-extractors', () => ({ ocrPdfWithGemini: vi.fn(), ocrImageWithGemini: vi.fn(), MAX_RAW_TEXT_LEN: 100_000 }))
vi.mock('./ai-usage', () => ({ recordAiUsage: vi.fn(async () => {}) }))

const OLD = new Date(Date.now() - 48 * 3600_000).toISOString()
const FRESH = new Date(Date.now() - 3600_000).toISOString()
const pad = (n: number) => String(n).padStart(4, '0')

// 游標存在模組裡：每個測試重新載入一次，從頭開始
let mod: typeof import('./ai-preview-jobs')
beforeEach(async () => {
  vi.resetModules()
  objects = []
  listCalls.length = 0
  mod = await import('./ai-preview-jobs')
})

describe('cleanupOrphanUploads：分頁掃，每個孤兒遲早都清得到', () => {
  it('⛔ 排在第 300 個之後的孤兒也清得到（前面 650 個都還沒滿 24 小時）', async () => {
    for (let i = 0; i < 650; i++) objects.push({ name: `preview-uploads/wsA/${pad(i)}.pdf`, timeCreated: FRESH })
    for (let i = 0; i < 40; i++) objects.push({ name: `preview-uploads/wsZ/${pad(i)}.pdf`, timeCreated: OLD })

    const r = await mod.cleanupOrphanUploads()
    expect(r).toMatchObject({ scanned: 690, purged: 40, failed: 0, reachedEnd: true })
    expect(objects.filter(o => o.timeCreated === OLD)).toHaveLength(0)
    expect(objects).toHaveLength(650) // 還沒滿 24 小時的一個都沒動
  })

  it('每輪掃的量有上限；沒掃完的下一輪從停下的地方接著掃，⛔ 不是每輪都從頭掃同一段', async () => {
    for (let i = 0; i < 200; i++) objects.push({ name: `preview-uploads/wsA/${pad(i)}.pdf`, timeCreated: FRESH })
    for (let i = 0; i < 30; i++) objects.push({ name: `preview-uploads/wsZ/${pad(i)}.pdf`, timeCreated: OLD })
    const opts = { pageSize: 50, maxScan: 100 }

    const first = await mod.cleanupOrphanUploads(50, opts)
    expect(first).toMatchObject({ scanned: 100, purged: 0, reachedEnd: false })
    const secondStarts = listCalls.length
    const second = await mod.cleanupOrphanUploads(50, opts)
    // 從上一輪最後看到的那一個接著掃（含它本身，重看一次無妨）
    expect(listCalls[secondStarts]).toMatchObject({ startOffset: 'preview-uploads/wsA/0099.pdf' })
    expect(second.purged).toBe(0)
    const third = await mod.cleanupOrphanUploads(50, opts)
    expect(third).toMatchObject({ purged: 30, reachedEnd: true })
    expect(objects.filter(o => o.timeCreated === OLD)).toHaveLength(0)
  })

  it('掃到底之後下一輪從頭來（開頭那段可能有剛滿 24 小時的）', async () => {
    for (let i = 0; i < 10; i++) objects.push({ name: `preview-uploads/wsM/${pad(i)}.pdf`, timeCreated: FRESH })
    await mod.cleanupOrphanUploads(50, { pageSize: 5, maxScan: 5 }) // 停在中間
    await mod.cleanupOrphanUploads(50, { pageSize: 5, maxScan: 50 }) // 接著掃到底
    objects.push({ name: 'preview-uploads/wsA/0000.pdf', timeCreated: OLD }) // 排在最前面的新孤兒
    const thirdStarts = listCalls.length
    const r = await mod.cleanupOrphanUploads(50, { pageSize: 5, maxScan: 50 })
    expect(r.purged).toBe(1)
    expect(listCalls[thirdStarts]?.startOffset).toBeUndefined()
  })

  it('一輪最多刪幾個照舊；刪不掉的照實回報、⛔ 不佔刪除上限（不然幾個壞檔就能讓每一輪都白跑）', async () => {
    for (let i = 0; i < 3; i++) objects.push({ name: `preview-uploads/wsA/${pad(i)}.pdf`, timeCreated: OLD, failDelete: true })
    for (let i = 3; i < 13; i++) objects.push({ name: `preview-uploads/wsA/${pad(i)}.pdf`, timeCreated: OLD })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = await mod.cleanupOrphanUploads(5)
    expect(r).toMatchObject({ purged: 5, failed: 3 })
    const r2 = await mod.cleanupOrphanUploads(5)
    expect(r2.purged).toBe(5)
    expect(objects.filter(o => !o.failDelete)).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('列舉失敗不丟錯（排程不能因此中斷），回 0', async () => {
    const spy = vi.spyOn(fakeBucket, 'getFiles').mockRejectedValueOnce(new Error('503'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(mod.cleanupOrphanUploads()).resolves.toMatchObject({ scanned: 0, purged: 0 })
    spy.mockRestore()
    warn.mockRestore()
  })
})

describe('findExistingSources：⛔ 回收桶裡的不算「已經有一份」', () => {
  function makeDb(docs: Array<{ id: string, data: Record<string, unknown> }>) {
    const q: any = { where: () => q, limit: () => q, get: async () => ({ docs: docs.map(d => ({ id: d.id, data: () => d.data })) }) }
    return { collection: () => q } as any
  }

  it('新的墓碑（isDeleted:true）跟舊的墓碑（只有 deletedAt）都濾掉，活著的照列', async () => {
    const db = makeDb([
      { id: 'binNew', data: { name: '說明書.pdf', type: 'file', isDeleted: true, deletedAt: { _seconds: 1 } } },
      { id: 'binLegacy', data: { name: '說明書.pdf', type: 'file', deletedAt: { _seconds: 1 } } },
      { id: 'live', data: { name: '說明書.pdf', type: 'file', isDeleted: false, chunkCount: 12, updatedAt: { _seconds: 100 } } },
      { id: 'legacyLive', data: { name: '說明書.pdf', type: 'file', chunkCount: 3 } },
    ])
    const hits = await mod.findExistingSources('ws1', '說明書.pdf', db)
    expect(hits.map(h => h.id)).toEqual(['live', 'legacyLive'])
    expect(hits[0]).toMatchObject({ chunkCount: 12, updatedAtMs: 100_000, type: 'file' })
  })

  it('同名那份會一起回「換掉它空得出多少空間」——不算草稿（2026-10-12 code review：開帳建的網址 30 條全是草稿，畫面卻承諾收得下）', async () => {
    // 照查詢條件回數字：全部 30、回收桶 0、草稿 30 → 換掉它空不出任何位置
    const counts: Record<string, number> = { all: 30, isDeleted: 0, status: 30 }
    const chain = (last: string): any => ({
      where: (field: string) => chain(['workspaceId', 'sourceId', 'name'].includes(field) ? last : field),
      limit: () => chain(last),
      get: async () => ({ docs: [{ id: 'web', data: () => ({ name: '官網', type: 'url', chunkCount: 30 }) }] }),
      count: () => ({ get: async () => ({ data: () => ({ count: counts[last] }) }) }),
    })
    const hits = await mod.findExistingSources('ws1', '官網', { collection: () => chain('all') } as any)
    expect(hits[0]).toMatchObject({ chunkCount: 30, quotaChunkCount: 0 })
  })

  it('濾完最多回 5 筆', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, data: { name: 'A', type: 'file', isDeleted: i < 3 } }))
    const hits = await mod.findExistingSources('ws1', 'A', makeDb(docs))
    expect(hits.map(h => h.id)).toEqual(['s3', 's4', 's5', 's6', 's7'])
  })
})

describe('cleanupOrphanJobFiles：沒有工作紀錄的暫存檔（C-303⑩）', () => {
  /** 假 db：只回「這個工作紀錄在不在」；live 裡的在，failRead 裡的讀取失敗 */
  const jobsDb = (live: string[], failRead: string[] = []) => ({
    collection: () => ({
      doc: (id: string) => ({
        get: async () => {
          if (failRead.includes(id)) throw new Error('unavailable')
          return { exists: live.includes(id) }
        },
      }),
    }),
  }) as any

  it('超過 24 小時、而且紀錄不在的才刪；紀錄還在、太新、讀不到紀錄的都留著', async () => {
    objects = [
      { name: 'preview-jobs/ws1/orphan/source.pdf', timeCreated: OLD },
      { name: 'preview-jobs/ws1/orphan/work.json', timeCreated: OLD },
      { name: 'preview-jobs/ws1/alive/work.json', timeCreated: OLD },
      { name: 'preview-jobs/ws1/fresh/work.json', timeCreated: FRESH },
      { name: 'preview-jobs/ws1/unknown/work.json', timeCreated: OLD },
      { name: 'preview-uploads/ws1/u1.pdf', timeCreated: OLD }, // 別的前綴不關它的事
    ]
    const r = await mod.cleanupOrphanJobFiles(jobsDb(['alive'], ['unknown']))
    expect(objects.map(o => o.name).sort()).toEqual([
      'preview-jobs/ws1/alive/work.json',
      'preview-jobs/ws1/fresh/work.json',
      'preview-jobs/ws1/unknown/work.json',
      'preview-uploads/ws1/u1.pdf',
    ])
    expect(r.purged).toBe(2)
  })
})
