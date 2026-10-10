import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDocx, makeZip } from '~~/server/utils/test-helpers/make-zip'

/**
 * 建整理工作端點收新檔案種類（`C-296`）：Word／簡報／CSV／文字檔／照片各走對的路。
 *
 * ⚠️ 為什麼要這一層：抽取函式各自都有單元測試，但「副檔名 → 哪一個抽取函式 → 哪一個階段」
 *    這段分派只活在端點裡——分錯的話（例如照片被當成 PDF 切頁）單元測試全綠、上傳必炸。
 * 正式庫零讀零寫：Firestore 與 Storage 全部換成記憶體裡的假物件。
 */

const WS = 'ws1'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
  Timestamp: { fromMillis: (ms: number) => ({ ms }), now: () => ({ ms: Date.now() }) },
}))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1' })),
}))
vi.mock('~~/server/utils/ai-usage', () => ({ assertMaintenanceBudget: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/ai-knowledge-sources', () => ({ findSourceByContentHash: vi.fn(async () => null) }))
vi.mock('~~/server/utils/pdf-split', () => ({ getPdfPageCount: vi.fn(async () => 1) }))

/** 假 Storage：上傳區放一個檔，讀完記錄刪除 */
let uploaded: Buffer = Buffer.alloc(0)
vi.mock('~~/server/utils/firebase', () => ({
  getDb: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }),
  getStorage: () => ({
    bucket: () => ({
      file: () => ({
        exists: async () => [true],
        getMetadata: async () => [{ size: uploaded.length }],
        download: async () => [uploaded],
        delete: async () => {},
      }),
    }),
  }),
}))

vi.mock('~~/server/utils/ai-preview-jobs', async (importActual) => {
  const actual = await importActual<typeof import('~~/server/utils/ai-preview-jobs')>()
  return {
    ...actual,
    cleanupExpiredPreviewJobs: vi.fn(async () => ({})),
    saveWork: vi.fn(async () => 1),
    saveSourceFile: vi.fn(async (_ws: string, _job: string, _buf: Buffer, ext: string) => `source.${ext}`),
  }
})

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { saveWork, saveSourceFile } = await import('~~/server/utils/ai-preview-jobs')
const { default: handler } = await import('./preview-jobs.post')

const call = () => (handler as unknown as (e: unknown) => Promise<any>)({})
const savedWork = () => vi.mocked(saveWork).mock.calls.at(-1)![2] as any

function upload(fileName: string, bytes: Buffer, contentType = '') {
  uploaded = bytes
  body = { type: 'file', fileName, contentType, storagePath: `preview-uploads/${WS}/abc.${fileName.split('.').pop()}` }
}

const p = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`
const tr = (...cells: string[]) => `<w:tr>${cells.map(c => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/ai/knowledge/preview-jobs — 新檔案種類', () => {
  it('Word：表格照欄位讀，交給 AI 整理（chunk 階段）', async () => {
    upload('退換貨政策.docx', makeDocx(p('退換貨政策') + `<w:tbl>${tr('項目', '期限')}${tr('退貨', '7 天')}</w:tbl>`))
    await expect(call()).resolves.toMatchObject({ status: 'processing', phase: 'chunk' })
    const work = savedWork()
    expect(work.sourceName).toBe('退換貨政策.docx')
    expect(work.segments.join('\n')).toContain('項目：退貨；期限：7 天')
    // 原檔留著（C-296③）：存一份在工作底下，型別用標準的（瀏覽器沒給也一樣）
    expect(vi.mocked(saveSourceFile).mock.calls[0]!.slice(3)).toEqual(['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
  })

  it('簡報整份讀不到字（都是圖片）→ 當場講要怎麼辦，⛔ 不要建一份 0 條的工作，也不留原檔（沒有工作就沒人清得掉）', async () => {
    upload('型錄.pptx', makeZip({ 'ppt/slides/slide1.xml': '<p:sld><p:pic/></p:sld>' }))
    await expect(call()).rejects.toMatchObject({ statusCode: 422, statusMessage: expect.stringContaining('存成圖片') })
    expect(saveWork).not.toHaveBeenCalled()
    expect(saveSourceFile).not.toHaveBeenCalled()
  })

  it('CSV（Big5）：一列一條、不走 AI 切卡（enrich 階段補客人問法）', async () => {
    upload('商品.csv', Buffer.from('ab7ea6572cbbf9aee60a573120524547454e2c2231322c393030220a', 'hex') /* 品名,價格↵W1 REGEN,"12,900"（iconv 產生） */)
    await call()
    const work = savedWork()
    expect(work.phase).toBe('enrich')
    expect(work.meta.encoding).toBe('big5')
    expect(work.chunks.map((c: any) => c.title)).toHaveLength(1)
  })

  it('文字檔：讀成文字交給 AI 整理', async () => {
    upload('常見問題.md', Buffer.from('# 運費\n滿千免運\n', 'utf8'))
    await expect(call()).resolves.toMatchObject({ phase: 'chunk' })
  })

  it('照片：原檔存起來、走認字（一張一步），⛔ 不可以被當成 PDF 切頁', async () => {
    upload('價目表.HEIC', Buffer.from('fake-heic-bytes'))
    await expect(call()).resolves.toMatchObject({ phase: 'ocr' })
    expect(vi.mocked(saveSourceFile).mock.calls[0]!.slice(3)).toEqual(['heic', 'image/heic'])
    const work = savedWork()
    expect(work.ocrMime).toBe('image/heic')
    expect(work.ocrPageTotal).toBe(1)
  })

  it('舊版 .doc → 400 並講要另存成 .docx', async () => {
    upload('說明書.doc', Buffer.from('old'))
    await expect(call()).rejects.toMatchObject({ statusCode: 400, statusMessage: expect.stringContaining('另存新檔') })
  })
})
