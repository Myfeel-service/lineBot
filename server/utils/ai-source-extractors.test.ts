import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { extractXlsxCards, extractXlsxText, isProbablyScannedPdf, resolveInternalUrl } from './ai-source-extractors'

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
