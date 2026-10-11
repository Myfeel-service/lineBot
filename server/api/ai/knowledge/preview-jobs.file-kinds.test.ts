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
const uploadDeletes = { count: 0 }
vi.mock('~~/server/utils/firebase', () => ({
  getDb: () => ({ collection: () => ({ doc: () => ({ set: async () => {} }) }) }),
  getStorage: () => ({
    bucket: () => ({
      file: () => ({
        exists: async () => [true],
        getMetadata: async () => [{ size: uploaded.length }],
        download: async () => [uploaded],
        delete: async () => { uploadDeletes.count++ },
      }),
      deleteFiles: async () => {},
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
// 抽取器照真的跑；要模擬「抽取器自己炸掉」或「讀不出來的字」時才換掉一次
vi.mock('~~/server/utils/ai-source-extractors', async (importActual) => {
  const actual = await importActual<typeof import('~~/server/utils/ai-source-extractors')>()
  return { ...actual, extractOfficeText: vi.fn(actual.extractOfficeText) }
})
vi.mock('~~/server/utils/office-extractors', async (importActual) => {
  const actual = await importActual<typeof import('~~/server/utils/office-extractors')>()
  return { ...actual, decodeTextBuffer: vi.fn(actual.decodeTextBuffer) }
})
vi.mock('~~/server/utils/google-sheets', async (importActual) => {
  const actual = await importActual<typeof import('~~/server/utils/google-sheets')>()
  return { ...actual, readGoogleSheetAsCards: vi.fn() }
})

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { saveWork, saveSourceFile } = await import('~~/server/utils/ai-preview-jobs')
const { extractOfficeText } = await import('~~/server/utils/ai-source-extractors')
const sourceActual = await vi.importActual<typeof import('~~/server/utils/ai-source-extractors')>('~~/server/utils/ai-source-extractors')
const officeActual = await vi.importActual<typeof import('~~/server/utils/office-extractors')>('~~/server/utils/office-extractors')
const { decodeTextBuffer } = await import('~~/server/utils/office-extractors')
const { readGoogleSheetAsCards } = await import('~~/server/utils/google-sheets')
const { default: handler } = await import('./preview-jobs.post')

const call = () => (handler as unknown as (e: unknown) => Promise<any>)({})
const savedWork = () => vi.mocked(saveWork).mock.calls.at(-1)![2] as any

function upload(fileName: string, bytes: Buffer, contentType = '') {
  uploaded = bytes
  body = { type: 'file', fileName, contentType, storagePath: `preview-uploads/${WS}/abc.${fileName.split('.').pop()}` }
}

const p = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`
const tr = (...cells: string[]) => `<w:tr>${cells.map(c => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`

/** 把指定的投影片在 zip 裡標成不認得的壓縮法：讀的時候會丟錯＝「讀不出來的投影片」（真的壞檔就是這個樣子） */
function breakEntries(zip: Buffer, names: string[]): Buffer {
  const out = Buffer.from(zip)
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = out.readUInt32LE(i)
    if (sig === 0x02014B50) {
      const name = out.subarray(i + 46, i + 46 + out.readUInt16LE(i + 28)).toString('utf8')
      if (names.includes(name)) out.writeUInt16LE(99, i + 10)
    }
    else if (sig === 0x04034B50) {
      const name = out.subarray(i + 30, i + 30 + out.readUInt16LE(i + 26)).toString('utf8')
      if (names.includes(name)) out.writeUInt16LE(99, i + 8)
    }
  }
  return out
}
const slide = (t: string) => `<p:sld><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sld>`

/** 「品名,價格↵W1 REGEN,"12,900"↵」的 Big5 位元組（iconv 產生） */
const BIG5_TABLE = Buffer.from('ab7ea6572cbbf9aee60a573120524547454e2c2231322c393030220a', 'hex')
/** 「品名↵價格↵」的 Big5 位元組：只有一欄，不算表格 → 退回 AI 整理那條路 */
const BIG5_ONE_COLUMN = Buffer.from('ab7ea6570abbf9aee60a', 'hex')

beforeEach(() => {
  vi.clearAllMocks()
  uploadDeletes.count = 0
  // 每個測試開始時換回真的（上一個測試可能換掉了）
  vi.mocked(extractOfficeText).mockImplementation(sourceActual.extractOfficeText)
  vi.mocked(decodeTextBuffer).mockImplementation(officeActual.decodeTextBuffer)
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
    upload('商品.csv', BIG5_TABLE)
    await call()
    const work = savedWork()
    expect(work.phase).toBe('enrich')
    expect(work.meta.encoding).toBe('big5')
    expect(work.chunks.map((c: any) => c.title)).toHaveLength(1)
    expect(work.warnings.filter((w: string) => w.includes('Big5'))).toHaveLength(1)
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

describe('收哪些檔：有副檔名只看副檔名（`C-296` 審查）', () => {
  it('⛔ x.html 配上「text/html; excel」→ 不收（以前被當成 Excel、原檔還用 text/html 存進雲端）', async () => {
    upload('x.html', Buffer.from('<html><script>alert(1)</script></html>'), 'text/html; excel')
    await expect(call()).rejects.toMatchObject({ statusCode: 400, statusMessage: expect.stringContaining('「.html」這種檔案目前不收') })
    expect(saveSourceFile).not.toHaveBeenCalled()
    expect(saveWork).not.toHaveBeenCalled()
    expect(uploadDeletes.count).toBe(1) // 上傳區那份照樣讀完就刪，不留孤兒
  })

  it('原檔存的型別一律用我們表上的，⛔ 不用瀏覽器給的', async () => {
    upload('退換貨政策.DOCX', makeDocx(p('退換貨政策') + p('七天內可退')), 'text/html')
    await expect(call()).resolves.toMatchObject({ phase: 'chunk' })
    expect(vi.mocked(saveSourceFile).mock.calls[0]!.slice(3)).toEqual(['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
  })

  it('沒有副檔名、型別一模一樣（帶參數也行）→ 收，存檔時補上副檔名', async () => {
    upload('退換貨政策', makeDocx(p('退換貨政策') + p('七天內可退')), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=binary')
    await expect(call()).resolves.toMatchObject({ phase: 'chunk' })
    expect(vi.mocked(saveSourceFile).mock.calls[0]!.slice(3)).toEqual(['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
  })

  it('⛔ 沒有副檔名、型別只是「含有 excel」→ 不收', async () => {
    upload('報表', Buffer.from('a,b\n1,2\n'), 'application/x-excel-but-not-really')
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('抽取器炸掉時講人話（`C-296` 審查）', () => {
  it('不是我們講好的錯（RangeError 之類）→ 422 一句人話，記一行 log，⛔ 不建工作、不留原檔', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(extractOfficeText).mockImplementationOnce(() => { throw new RangeError('Offset is outside the bounds of the DataView') })
    upload('說明書.docx', makeDocx(p('保固一年')))
    await expect(call()).rejects.toMatchObject({ statusCode: 422, statusMessage: '讀不出這份檔案的內容，可能檔案壞了；請用原本的軟體另存一份再試' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('RangeError')
    expect(saveWork).not.toHaveBeenCalled()
    expect(saveSourceFile).not.toHaveBeenCalled()
    expect(uploadDeletes.count).toBe(1)
    warn.mockRestore()
  })

  it('講好的錯（有 statusCode）原樣往上丟，不被換成那句通用的', async () => {
    vi.mocked(extractOfficeText).mockImplementationOnce(() => {
      throw Object.assign(new Error('無法讀取這份 Word 檔（有密碼保護）'), { statusCode: 422, statusMessage: '無法讀取這份 Word 檔（有密碼保護）' })
    })
    upload('說明書.docx', makeDocx(p('保固一年')))
    await expect(call()).rejects.toMatchObject({ statusCode: 422, statusMessage: '無法讀取這份 Word 檔（有密碼保護）' })
  })
})

describe('Word／簡報格式複雜到讀到一半就停：要講（2026-10-11）', () => {
  it('讀取額度用完（textTruncated）、字數卻沒撞到 10 萬字 → 另外講「只讀了前面一部分」', async () => {
    vi.mocked(extractOfficeText).mockImplementationOnce(() => ({ text: '保固一年', rawLength: 4, meta: { format: 'docx', textTruncated: 1 } }))
    upload('說明書.docx', makeDocx(p('保固一年')))
    await expect(call()).resolves.toMatchObject({ phase: 'chunk' })
    expect(savedWork().truncated).toBe(false)
    expect(savedWork().warnings).toEqual(expect.arrayContaining([expect.stringContaining('只讀了前面一部分')]))
  })

  it('正常讀完的不講', async () => {
    upload('說明書.docx', makeDocx(p('保固一年')))
    await expect(call()).resolves.toMatchObject({ phase: 'chunk' })
    expect(savedWork().warnings.join('')).not.toContain('只讀了前面一部分')
  })
})

describe('簡報一個字都沒讀到：分清楚「都是圖片」跟「檔案壞了」', () => {
  it('每一張都讀不出來 → 說檔案可能壞了、請另存一份（⛔ 不是叫他存成圖片）', async () => {
    const zip = makeZip({ 'ppt/slides/slide1.xml': slide('第一張'), 'ppt/slides/slide2.xml': slide('第二張') }, 0)
    upload('型錄.pptx', breakEntries(zip, ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']))
    const err = await call().catch(e => e)
    // 抽取器自己就會講（office-extractors 的 badZip）；它沒講的話由 preview-jobs 的 emptySlidesMessage 講——兩邊都要是「壞了」
    expect(err).toMatchObject({ statusCode: 422, statusMessage: expect.stringMatching(/讀不出來.*(壞|損)/) })
    expect(err.statusMessage).not.toContain('圖片')
  })

  it('抽取器沒丟錯、只回「0 個字＋每張都讀不出來」時，preview-jobs 自己也講「壞了」', async () => {
    vi.mocked(extractOfficeText).mockImplementationOnce(() => ({ text: '', rawLength: 0, meta: { slides: 3, slidesWithText: 0, slidesUnreadable: 3 } }))
    upload('型錄.pptx', makeZip({ 'ppt/slides/slide1.xml': slide('x') }))
    await expect(call()).rejects.toMatchObject({ statusCode: 422, statusMessage: '這份簡報的 3 張投影片都讀不出來，檔案可能壞了；請用 PowerPoint 打開後另存一份再傳' })
  })

  it('有的是圖片、有的讀不出來 → 兩件事都講', async () => {
    const zip = makeZip({ 'ppt/slides/slide1.xml': '<p:sld><p:pic/></p:sld>', 'ppt/slides/slide2.xml': slide('第二張') }, 0)
    upload('型錄.pptx', breakEntries(zip, ['ppt/slides/slide2.xml']))
    await expect(call()).rejects.toMatchObject({
      statusCode: 422,
      statusMessage: expect.stringMatching(/1 張投影片看起來是圖片、1 張讀不出來/),
    })
  })
})

describe('純文字類的編碼警告：三條路講同一套話', () => {
  it('Big5 的文字檔（.txt）也要講是 Big5（以前只有 CSV 一列一卡那條會講）', async () => {
    upload('商品.txt', BIG5_TABLE)
    await expect(call()).resolves.toMatchObject({ phase: 'chunk' })
    const work = savedWork()
    expect(work.meta.encoding).toBe('big5')
    expect(work.warnings).toEqual(expect.arrayContaining([expect.stringContaining('這份文字檔是 Big5 編碼')]))
  })

  it('Big5 的 CSV 不是表格、退回 AI 整理那條路 → 也要講是 Big5', async () => {
    upload('清單.csv', BIG5_ONE_COLUMN)
    await expect(call()).resolves.toMatchObject({ phase: 'chunk' })
    const work = savedWork()
    expect(work.meta.encoding).toBe('big5')
    expect(work.warnings).toEqual(expect.arrayContaining([expect.stringContaining('這份 CSV 是 Big5 編碼')]))
  })

  it('真的檔：UTF-8 文字裡夾了一個壞位元組（複製貼上帶進來的）→ 照 UTF-8 讀、講有 1 個字讀不出來', async () => {
    upload('常見問題.txt', Buffer.concat([Buffer.from('運費：滿千免運，偏遠地區另計。', 'utf8'), Buffer.from([0xFF]), Buffer.from('\n')]))
    await call()
    const work = savedWork()
    expect(work.meta.encoding).toBe('utf-8')
    expect(work.warnings).toEqual(expect.arrayContaining([expect.stringContaining('有 1 個字讀不出來')]))
    expect(work.warnings.some((w: string) => w.includes('是 Big5 編碼'))).toBe(false)
  })

  it('短檔有 1 個字讀不出來就講幾個、怎麼辦', async () => {
    vi.mocked(decodeTextBuffer).mockImplementation(b => ({ ...officeActual.decodeTextBuffer(b), unreadableChars: 1 }))
    upload('常見問題.txt', Buffer.from('運費：滿千免運，偏遠地區另計。', 'utf8'))
    await call()
    expect(savedWork().warnings).toEqual(expect.arrayContaining([
      '有 1 個字讀不出來（變成 �），檔案可能不是 UTF-8 或 Big5 編碼；請用記事本或 Excel 另存成 UTF-8 再匯入一次',
    ]))
  })

  it('CSV 一列一卡那條路也講讀不出來的字', async () => {
    vi.mocked(decodeTextBuffer).mockImplementation(b => ({ ...officeActual.decodeTextBuffer(b), unreadableChars: 2 }))
    upload('商品.csv', Buffer.from('品名,價格\nW1,12900\n', 'utf8'))
    await call()
    expect(savedWork().phase).toBe('enrich')
    expect(savedWork().warnings).toEqual(expect.arrayContaining([expect.stringContaining('有 2 個字讀不出來')]))
  })

  it('長檔（2000 字以上）零星 1、2 個不講（每次都提醒只會變成噪音），3 個以上才講', async () => {
    const long = Buffer.from(`${'滿千免運。'.repeat(500)}\n`, 'utf8')
    vi.mocked(decodeTextBuffer).mockImplementation(b => ({ ...officeActual.decodeTextBuffer(b), unreadableChars: 2 }))
    upload('長文.txt', long)
    await call()
    expect(savedWork().warnings.some((w: string) => w.includes('讀不出來'))).toBe(false)

    vi.mocked(decodeTextBuffer).mockImplementation(b => ({ ...officeActual.decodeTextBuffer(b), unreadableChars: 3 }))
    upload('長文.txt', long)
    await call()
    expect(savedWork().warnings).toEqual(expect.arrayContaining([expect.stringContaining('有 3 個字讀不出來')]))
  })
})

describe('「原文超過 10 萬字已截斷」只在真的被字數上限截掉時才講', () => {
  it('⛔ 表格超過 150 列被列數上限擋下 → 不算 truncated（只講「前 150 列」那句，兩句不打架）', async () => {
    const rows = Array.from({ length: 160 }, (_, i) => `商品 ${i + 1},${100 + i}`).join('\n')
    upload('商品.csv', Buffer.from(`品名,價格\n${rows}\n`, 'utf8'))
    await call()
    const work = savedWork()
    expect(work.truncated).toBe(false)
    // 「列」或「條」都行（那句話的用字由 google-sheets 決定），要的是列數上限那句在、字數截斷那句不在
    expect(work.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/只會匯入前 150 [列條]/)]))
  })

  it('⛔ Google 試算表超過 150 列也一樣', async () => {
    vi.mocked(readGoogleSheetAsCards).mockResolvedValueOnce({
      sheetTitle: '價目表',
      cards: [{ title: '拿鐵', content: '60 元', tags: [] }],
      stats: {
        rowCount: 160,
        skippedNoTitle: 0,
        mergedRows: 0,
        truncatedByCap: true,
        duplicateTitles: [],
        blankAnswerTitles: [],
        titleRows: [],
        continuedRows: 0,
      },
      mergeCount: 0,
      skippedSheets: [],
      emptySheets: [],
    } as never)
    body = { type: 'gsheet', url: 'https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz0123456789/edit#gid=0' }
    await call()
    const work = savedWork()
    expect(work.truncated).toBe(false)
    expect(work.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/只會匯入前 150 [列條]/)]))
  })

  it('文字真的超過 10 萬字 → 照講', async () => {
    upload('長文.txt', Buffer.from('滿千免運。'.repeat(20_001), 'utf8'))
    await call()
    expect(savedWork().truncated).toBe(true)
  })
})
