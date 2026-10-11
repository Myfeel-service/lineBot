import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { makeZip } from './test-helpers/make-zip'
import { extractXlsxCards, extractXlsxText, isProbablyScannedPdf, resolveInternalUrl } from './ai-source-extractors'
import { sheetHealthWarnings } from './google-sheets'

// 讀壞檔時會丟 Nuxt 全域的 createError；unit 測試環境沒有，補一個最小版
;(globalThis as unknown as { createError?: unknown }).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

function extracted(rawLength: number, pages: number) {
  return { text: 'x'.repeat(Math.min(rawLength, 100)), rawLength, meta: { pages } }
}

describe('resolveInternalUrl', () => {
  const base = 'https://shop.example.com/'
  it('相對路徑解析成絕對網址', () => {
    expect(resolveInternalUrl('/projects/abc', base)).toBe('https://shop.example.com/projects/abc')
  })
  it('同網域絕對網址保留', () => {
    expect(resolveInternalUrl('https://shop.example.com/p/1', base)).toBe('https://shop.example.com/p/1')
  })
  it('跨網域 → null（避免帶外部社群連結雜訊）', () => {
    expect(resolveInternalUrl('https://facebook.com/x', base)).toBeNull()
  })
  it('非 http(s)（js / mailto / tel）→ null', () => {
    expect(resolveInternalUrl('javascript:void(0)', base)).toBeNull()
    expect(resolveInternalUrl('mailto:a@b.com', base)).toBeNull()
    expect(resolveInternalUrl('tel:0800', base)).toBeNull()
  })
  it('純錨點解析回本頁網址（同網域 http，保留）', () => {
    expect(resolveInternalUrl('#section', base)).toBe('https://shop.example.com/#section')
  })
})

describe('isProbablyScannedPdf', () => {
  it('完全沒文字層 → 掃描檔', () => {
    expect(isProbablyScannedPdf(extracted(0, 5))).toBe(true)
  })

  it('只剩浮水印 / 頁首零星文字 → 掃描檔', () => {
    // 10 頁只有 80 字(平均 8 字/頁)
    expect(isProbablyScannedPdf(extracted(80, 10))).toBe(true)
    // 20 頁 300 字(平均 15 字/頁)
    expect(isProbablyScannedPdf(extracted(300, 20))).toBe(true)
  })

  it('正常文字 PDF → 不是掃描檔', () => {
    // 1 頁 600 字
    expect(isProbablyScannedPdf(extracted(600, 1))).toBe(false)
    // 30 頁 4 萬字
    expect(isProbablyScannedPdf(extracted(40_000, 30))).toBe(false)
  })

  it('短但密度夠的單頁文件 → 不是掃描檔', () => {
    expect(isProbablyScannedPdf(extracted(150, 1))).toBe(false)
  })

  it('拿不到頁數時退回總字數判斷', () => {
    expect(isProbablyScannedPdf(extracted(10, 0))).toBe(true)
    expect(isProbablyScannedPdf(extracted(500, 0))).toBe(false)
  })

  it('大檔卻只抽出很少字(薄文字層騙過每頁門檻)→ 掃描檔', () => {
    // 5MB 型錄只抽出 3000 字(平均 150 字/頁,越過每頁門檻)→ 但 ~1667 bytes/字 → 影像檔
    expect(isProbablyScannedPdf(extracted(3000, 20), 5_000_000)).toBe(true)
  })

  it('大檔但文字也多(真文字 PDF 夾大圖)→ 不是掃描檔', () => {
    // 5MB 但抽出 8 萬字 → ~62 bytes/字 → 有實質文字層
    expect(isProbablyScannedPdf(extracted(80_000, 40), 5_000_000)).toBe(false)
  })

  it('沒給 byteLength(舊呼叫端)→ 只看字數門檻,行為不變', () => {
    // 同樣 3000 字 / 20 頁,不帶 byteLength 就不會被新規則判成掃描檔
    expect(isProbablyScannedPdf(extracted(3000, 20))).toBe(false)
  })
})

// ── xlsx：說明分頁跳過 + 合併儲存格展開 ─────────────────────────────

/** 在記憶體組一本 xlsx。sheets: [{ name, rows, merges?, origin?, ref? }]；merges 用 xlsx 的 s/e（含）格式 */
function makeXlsx(
  sheets: Array<{ name: string; rows: string[][]; merges?: XLSX.Range[]; origin?: string; ref?: string }>,
): Buffer {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws = s.origin
      ? XLSX.utils.sheet_add_aoa(XLSX.utils.aoa_to_sheet([['']]), s.rows, { origin: s.origin })
      : XLSX.utils.aoa_to_sheet(s.rows)
    // 手動覆寫 !ref 以模擬「資料不從 A1 起算」的真實檔（aoa_to_sheet 會把 !ref 正規化回 A1）
    if (s.ref) ws['!ref'] = s.ref
    if (s.merges) ws['!merges'] = s.merges
    XLSX.utils.book_append_sheet(wb, ws, s.name)
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

const faqRows = [
  ['客人會問的問題', '答案'],
  ['退款多久?', '3-5 個工作天'],
  ['運費多少?', '滿千免運'],
]
const guideRows = [
  ['📖 FAQ 範本使用說明', ''],
  ['1', '在 FAQ 分頁填寫,一列一題'],
]

describe('extractXlsxCards — 說明分頁 / 合併儲存格', () => {
  it('跳過「使用說明」類分頁,只匯資料分頁(官方範本上傳不會混進說明卡)', () => {
    const buf = makeXlsx([
      { name: 'FAQ', rows: faqRows },
      { name: '使用說明', rows: guideRows },
    ])
    const res = extractXlsxCards(buf)
    expect(res).not.toBeNull()
    expect(res!.sheetCount).toBe(1)
    expect(res!.cards.map(c => c.title)).toEqual(['退款多久?', '運費多少?'])
  })

  it('FAQ 頁＋自己加的「價目表」兩頁都讀（C-296），跳過的說明頁要回報', () => {
    const buf = makeXlsx([
      { name: 'FAQ', rows: faqRows },
      { name: '價目表', rows: [['品名', '價格'], ['W1 REGEN 改', '12,900']] },
      { name: '使用說明', rows: guideRows },
    ])
    const res = extractXlsxCards(buf)!
    expect(res.cards.map(c => c.title)).toEqual(['退款多久?', '運費多少?', 'W1 REGEN 改'])
    expect(res.skippedSheets).toEqual(['使用說明'])
  })

  it('不同分頁同一個名稱併成一張、只有一欄的分頁回報沒收進來（⛔ 不默默少一頁）', () => {
    const buf = makeXlsx([
      { name: '價目表', rows: [['品名', '價格'], ['W1', '12,900']] },
      { name: '規格', rows: [['品名', '容量'], ['W1', '12L']] },
      { name: '注意事項', rows: [['請勿冷凍'], ['開封後冷藏']] },
    ])
    const res = extractXlsxCards(buf)!
    expect(res.cards).toEqual([{ title: 'W1', content: '12,900\n12L', tags: [] }])
    expect(res.stats.duplicateTitles).toEqual(['W1'])
    expect(res.emptySheets).toEqual(['注意事項'])
  })

  it('整本只有說明類名稱的分頁 → 照讀(不讓使用者面對空結果)', () => {
    const buf = makeXlsx([{ name: '使用說明', rows: faqRows }])
    const res = extractXlsxCards(buf)
    expect(res).not.toBeNull()
    expect(res!.cards.length).toBe(2)
  })

  it('直向合併儲存格自動展開救回被合併列,同標題併成一張卡、內容相接,回報 mergeCount', () => {
    const rows = [
      ['問題', '答案'],
      ['退款流程', '第一步'],
      ['', '第二步'], // 標題欄與上一列合併
    ]
    const buf = makeXlsx([{
      name: 'FAQ',
      rows,
      merges: [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }],
    }])
    const res = extractXlsxCards(buf)
    expect(res).not.toBeNull()
    expect(res!.mergeCount).toBe(1)
    // 兩列同標題「退款流程」→ 併成一張卡（不再是會被同步吃掉的重複卡）
    expect(res!.cards.map(c => c.title)).toEqual(['退款流程'])
    expect(res!.cards[0]!.content).toContain('第一步')
    expect(res!.cards[0]!.content).toContain('第二步')
  })

  it('純橫向合併（標題橫幅）不計入 mergeCount（沒展開就不該報「已自動展開」）', () => {
    const buf = makeXlsx([{
      name: 'FAQ',
      rows: [['問題', '答案'], ['退款', '3 天'], ['運費', '滿千免運']],
      merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }], // A1:B1 純橫向
    }])
    const res = extractXlsxCards(buf)
    expect(res).not.toBeNull()
    expect(res!.mergeCount).toBe(0)
  })

  it('資料不從 A1 起算（!ref=A3:B5）時,合併座標仍對齊 !ref 原點,救回被合併列', () => {
    // !merges 是絕對格線座標（A4:A5 = r3-r4）,但 sheet_to_json 回傳的列相對於 !ref（A3）原點。
    // 未校正原點時 rows[3] 會是 undefined → 合併被跳過 → '第二步' 那列因沒標題被整列丟掉。
    const buf = makeXlsx([{
      name: 'FAQ',
      rows: [
        ['問題', '答案'],
        ['退款流程', '第一步'],
        ['', '第二步'], // 標題欄與上一列合併
      ],
      origin: 'A3',
      ref: 'A3:B5',
      merges: [{ s: { r: 3, c: 0 }, e: { r: 4, c: 0 } }],
    }])
    const res = extractXlsxCards(buf)
    expect(res).not.toBeNull()
    expect(res!.mergeCount).toBe(1)
    // 救回被合併列後同標題併成一張卡（若沒對齊原點,'第二步' 那列會整列漏掉 → cards 只有 1 張但缺內容）
    expect(res!.cards.map(c => c.title)).toEqual(['退款流程'])
    expect(res!.cards[0]!.content).toContain('第二步')
  })
})

describe('extractXlsxText — 說明分頁', () => {
  it('LLM 切卡的散文路徑同樣跳過說明分頁', () => {
    const buf = makeXlsx([
      { name: '產品介紹', rows: [['我們的產品線涵蓋家電與咖啡設備'], ['歡迎詢問']] },
      { name: 'README', rows: guideRows },
    ])
    const res = extractXlsxText(buf)
    expect(res.text).toContain('產品介紹')
    expect(res.text).not.toContain('範本使用說明')
  })
})

describe('CSV（C-296）', () => {
  // 「品名,價格,客服電話\nW1 REGEN 改,"12,900",0912345678」的 Big5 bytes（iconv 產生）——台灣購物平台匯出常見的編碼
  const big5Csv = Buffer.from('ab7ea6572cbbf9aee62cabc8aa41b971b8dc0a573120524547454e20a7ef2c2231322c393030222c303931323334353637380a', 'hex')

  it('Big5 的 CSV 讀得懂、一列一條，電話前面的 0 不會掉、帶千分位的價格不會被拆開', () => {
    const res = extractXlsxCards(big5Csv, 'csv')!
    expect(res.encoding).toBe('big5')
    expect(res.cards).toEqual([{ title: 'W1 REGEN 改', content: '價格：12,900\n客服電話：0912345678', tags: [] }])
  })

  it('UTF-8 的 CSV、最上面有一行標題：欄位名稱用下一列', () => {
    const csv = Buffer.from('2026 秋季價目表,,\n品名,容量,價格\nW1 mini,6L,"8,990"\n', 'utf8')
    const res = extractXlsxCards(csv, 'csv')!
    expect(res.cards).toEqual([{ title: 'W1 mini', content: '容量：6L\n價格：8,990', tags: [] }])
    expect(res.stats.titleRows).toEqual(['2026 秋季價目表'])
  })
})

// ── 2026-10-11 審查修正 ─────────────────────────────────────────────

describe('Apple Numbers 輸出的 Excel（照本機 Numbers 實際輸出的樣子組，finding 8／9）', () => {
  // 實檔長這樣：第一頁「輸出摘要」是 Numbers 自己加的說明；價目表的表格從第 2 列開始（!ref A2:D7）
  const numbersBook = () => makeXlsx([
    {
      name: '輸出摘要',
      rows: [
        ['此文件從 Numbers 輸出。已將每個表格轉換為不同的 Excel 工作表。', '', ''],
        ['', '', ''],
        ['Numbers 工作表名稱', 'Numbers 表格名稱', 'Excel 工作表名稱'],
        ['價目表', '', ''],
        ['', '表格 1', '價目表'],
      ],
    },
    {
      name: '價目表',
      rows: [
        ['2026 秋季價目表', '', '', ''],
        ['品名', '容量', '價格', '客服電話'],
        ['W1 REGEN 改', '12L', '12900', '0912345678'],
        ['W1 mini', '6L', '8990', '0912345678'],
        ['', '濾網（2 入）', '990', ''], // 沒填品名的那一列：併到上一項，要講第幾列
      ],
      origin: 'A2',
      ref: 'A2:D6',
    },
    { name: '常見問題', rows: [['問題', '答案'], ['可以退貨嗎？', '收到 7 天內可退']] },
  ])

  it('輸出摘要不變成卡、不被講成「使用說明」，改講 Numbers 自動加的', () => {
    const res = extractXlsxCards(numbersBook())!
    expect(res.cards.map(c => c.title)).toEqual(['W1 REGEN 改', 'W1 mini', '可以退貨嗎？'])
    expect(res.skippedSheets).toEqual([])
    expect(res.stats.exportSummarySheets).toEqual(['輸出摘要'])
    expect(sheetHealthWarnings(res.cards, res.stats)).toContain('略過「輸出摘要」分頁（Numbers 輸出時自動加的說明頁，不是資料）')
  })

  it('沒填品名的那一列講得出是試算表上的第幾列、併到哪一項（表格從第 2 列開始也對得上）', () => {
    const res = extractXlsxCards(numbersBook())!
    expect(res.cards.find(c => c.title === 'W1 mini')!.content).toContain('容量：濾網（2 入）\n價格：990')
    expect(sheetHealthWarnings(res.cards, res.stats)).toContain('「價目表」第 6 列沒有「品名」，已併到上一項「W1 mini」；不對的話請補上再匯入一次')
  })

  it('散文那條（extractXlsxText）同樣不讀輸出摘要', () => {
    expect(extractXlsxText(numbersBook()).text).not.toContain('此文件從 Numbers 輸出')
  })
})

describe('讀不出來的檔：畫面講人話、技術細節只進 log 一行（finding 11）', () => {
  afterEach(() => vi.restoreAllMocks())
  const broken = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(200, 7)])

  it('錯誤訊息不帶解析器的英文原文；先試表格、再走散文那條，檔案只讀一次、log 只記一行', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    // 跟 preview-jobs 同順序：表格那條回 null，接著同一個 buffer 走散文那條
    expect(extractXlsxCards(broken)).toBeNull()
    let caught: { statusCode?: number, statusMessage?: string } | null = null
    try { extractXlsxText(broken) }
    catch (e) { caught = e as never }
    expect(caught).toMatchObject({ statusCode: 422, statusMessage: '讀不出這份試算表，可能檔案壞了或有密碼；請用 Excel 另存一份再試' })
    expect(caught!.statusMessage).not.toContain('Unsupported') // 解析器的英文原文不上畫面
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toHaveLength(1) // 一行字串，不是整個 Error 物件（會印整段 stack）
    expect(String(warn.mock.calls[0]![0])).toContain('Unsupported ZIP encryption')
    expect(error).not.toHaveBeenCalled()
  })

  it('交棒只給同一個 buffer 用一次：再呼叫一次就重新讀（不會一直拿到舊結果）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(extractXlsxCards(broken)).toBeNull()
    expect(() => extractXlsxText(broken)).toThrow()
    expect(() => extractXlsxText(broken)).toThrow()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('不是表格（單欄清單）→ 表格那條回 null，散文那條拿到同一份內容', () => {
    const csv = Buffer.from('開封後請冷藏\n七天內食用完畢\n', 'utf8')
    expect(extractXlsxCards(csv, 'csv')).toBeNull()
    expect(extractXlsxText(csv, 'csv').text).toContain('七天內食用完畢')
  })
})

describe('壞掉、大到不正常的 xlsx：不卡死、不撐爆記憶體（2026-10-11 破檔測試）', () => {
  afterEach(() => vi.restoreAllMocks())

  // 擋住它的有兩道，各自都擋得住（2026-10-11 逐一拿掉驗過）：交給 SheetJS 之前自己先解一次（壞的項目當場丟錯）、
  // 和 use_zlib（SheetJS 改用 Node 的 zlib 解壓）。⚠️ 這條要是卡住不動＝兩道都被拿掉了
  it('會讓 SheetJS 自己的解壓無限迴圈的壞檔 → 很快丟 422', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 真的 Numbers 匯出檔（假資料），只改了 sharedStrings 那個項目檔頭的「檔名長度」一個欄位——
    // SheetJS 內建的純 JS 解壓讀到這裡會一直轉，整個請求卡到逾時（破檔測試實測卡 20 分鐘）
    const broken = readFileSync(fileURLToPath(new URL('./test-helpers/fixtures/sheetjs-zip-hang.xlsx', import.meta.url)))
    const t0 = Date.now()
    expect(extractXlsxCards(broken)).toBeNull()
    expect(() => extractXlsxText(broken)).toThrow(expect.objectContaining({ statusCode: 422 }))
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('解開之後超過 250MB → 422 講「大到不正常」、怎麼辦，⛔ 不交給 SheetJS 硬解（換成 zlib 之後它解壓沒有上限）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bomb = makeZip({ '[Content_Types].xml': '<Types/>', 'xl/worksheets/sheet1.xml': '<worksheet/>' }, 8, { declaredSize: 300 * 1024 * 1024 })
    expect(() => extractXlsxText(bomb)).toThrow(expect.objectContaining({
      statusCode: 422,
      statusMessage: expect.stringContaining('大到不正常'),
    }))
  })

  it('正常的 xlsx 照常讀（先自己解一次量大小，不影響內容）', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['品名', '價格'], ['W1', '12,900']]), '價目表')
    const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    expect(extractXlsxCards(buf)!.cards.map(c => c.title)).toEqual(['W1'])
  })
})
