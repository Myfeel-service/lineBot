import { describe, expect, it } from 'vitest'

// google-sheets.ts 用 Nuxt 全域 createError 丟 4xx 錯誤；unit 測試環境沒有這個全域，補一個最小版。
;(globalThis as unknown as { createError?: unknown }).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

import {
  countVerticalMerges,
  expandVerticalMerges,
  GSHEET_MAX_ROWS,
  isInstructionSheetName,
  parseGoogleSheetUrl,
  readGoogleSheetAsCards,
  rowsToCards,
  rowToCard,
  selectDataSheetNames,
  type SheetImportStats,
  sheetHealthWarnings,
  type SheetsApiFn,
} from './google-sheets'

describe('parseGoogleSheetUrl', () => {
  it('解析完整網址含 gid', () => {
    const r = parseGoogleSheetUrl('https://docs.google.com/spreadsheets/d/1AbC-_dEf/edit#gid=123')
    expect(r).toEqual({ spreadsheetId: '1AbC-_dEf', gid: '123' })
  })

  it('完整網址沒有 gid → gid null', () => {
    const r = parseGoogleSheetUrl('https://docs.google.com/spreadsheets/d/1AbC-_dEf/edit')
    expect(r).toEqual({ spreadsheetId: '1AbC-_dEf', gid: null })
  })

  it('純 spreadsheet id', () => {
    const id = 'a'.repeat(30)
    expect(parseGoogleSheetUrl(id)).toEqual({ spreadsheetId: id, gid: null })
  })

  it('無效輸入回 null', () => {
    expect(parseGoogleSheetUrl('')).toBeNull()
    expect(parseGoogleSheetUrl('https://example.com/foo')).toBeNull()
    expect(parseGoogleSheetUrl('short')).toBeNull()
  })
})

describe('rowToCard', () => {
  const headers = ['商品', '價格', '庫存', '備註']

  it('多欄表：標題=第一欄，內容=其餘欄表頭:值', () => {
    const card = rowToCard(headers, ['除濕機', '3990', '5', '附發票'])
    expect(card).toEqual({
      title: '除濕機',
      content: '價格：3990\n庫存：5\n備註：附發票',
      tags: [],
    })
  })

  it('多欄表：空值欄略過', () => {
    const card = rowToCard(headers, ['除濕機', '3990', '', ''])
    expect(card?.content).toBe('價格：3990')
  })

  it('兩欄表（FAQ）：內容=第二欄整段', () => {
    const card = rowToCard(['問題', '答案'], ['運費多少', '滿千免運，未滿 80 元'])
    expect(card).toEqual({ title: '運費多少', content: '滿千免運，未滿 80 元', tags: [] })
  })

  it('第一欄空白 → 跳過該列（回 null）', () => {
    expect(rowToCard(headers, ['', '3990', '5', ''])).toBeNull()
  })

  it('單欄 / 無其他內容 → 用標題自身當內容', () => {
    expect(rowToCard(['商品'], ['除濕機'])?.content).toBe('除濕機')
  })
})

describe('selectDataSheetNames / isInstructionSheetName', () => {
  it('有 FAQ 分頁 → 只選 FAQ 頁（跳過使用說明/工作表1）', () => {
    expect(selectDataSheetNames(['使用說明', 'FAQ', '工作表1'])).toEqual(['FAQ'])
  })

  it('多個 FAQ / 常見問 分頁 → 全選', () => {
    expect(selectDataSheetNames(['FAQ', '常見問題', '使用說明'])).toEqual(['FAQ', '常見問題'])
  })

  it('沒 FAQ 分頁 → 全部「非說明」分頁（xlsx 與 gsheet 一致，不再只挑一個）', () => {
    expect(selectDataSheetNames(['使用說明', '商品資料', '報價'])).toEqual(['商品資料', '報價'])
  })

  it('整份都是說明類名稱 → 保底全讀', () => {
    expect(selectDataSheetNames(['使用說明', '填寫教學'])).toEqual(['使用說明', '填寫教學'])
  })

  it('資料分頁名含「說明」不會被誤跳（商品說明照選）', () => {
    expect(selectDataSheetNames(['使用說明', '商品說明'])).toEqual(['商品說明'])
  })

  it('isInstructionSheetName 認得常見說明類名稱', () => {
    expect(isInstructionSheetName('使用說明')).toBe(true)
    expect(isInstructionSheetName('📖 填寫教學')).toBe(true)
    expect(isInstructionSheetName('README')).toBe(true)
    expect(isInstructionSheetName('FAQ')).toBe(false)
    expect(isInstructionSheetName('工作表1')).toBe(false)
  })

  it('isInstructionSheetName 不誤傷內含「說明/教學」的資料分頁名', () => {
    // 這些是合法資料分頁,不能被當成教學頁跳過(否則整頁資料靜默漏掉)
    expect(isInstructionSheetName('商品說明')).toBe(false)
    expect(isInstructionSheetName('產品說明')).toBe(false)
    expect(isInstructionSheetName('退換貨說明')).toBe(false)
    expect(isInstructionSheetName('教學課程清單')).toBe(false)
  })
})

describe('expandVerticalMerges', () => {
  it('直向合併：錨點值沿該欄往下補到既有列（救回會被丟掉的列）', () => {
    const rows = [
      ['問題', '答案'],
      ['退款流程', '第一步'],
      ['', '第二步'], // 標題欄被合併,原本會因沒標題整列丟掉
    ]
    expandVerticalMerges(rows, [{ startRow: 1, endRow: 3, startCol: 0, endCol: 1 }])
    expect(rows[2]![0]).toBe('退款流程')
  })

  it('純橫向合併不展開（避免內容重複）', () => {
    const rows = [['Q', 'A 跨兩欄']]
    expandVerticalMerges(rows, [{ startRow: 0, endRow: 1, startCol: 1, endCol: 3 }])
    expect(rows[0]).toEqual(['Q', 'A 跨兩欄'])
  })

  it('合併範圍超出既有列數 → 不無中生有造列', () => {
    const rows = [['問題', '答案'], ['退款', '說明']]
    expandVerticalMerges(rows, [{ startRow: 1, endRow: 5, startCol: 0, endCol: 1 }])
    expect(rows.length).toBe(2)
  })

  it('目標格已有值不覆蓋、短列自動補齊長度', () => {
    const rows = [
      ['退款', '說明'],
      ['自己的標題', 'x'],
      [], // 空列(長度 0)
    ]
    expandVerticalMerges(rows, [{ startRow: 0, endRow: 3, startCol: 0, endCol: 1 }])
    expect(rows[1]![0]).toBe('自己的標題')
    expect(rows[2]![0]).toBe('退款')
  })
})

describe('countVerticalMerges', () => {
  it('只算直向（跨 ≥2 列）合併；純橫向合併不算（沒展開就不該計入健檢）', () => {
    const merges = [
      { startRow: 1, endRow: 3, startCol: 0, endCol: 1 }, // 直向：2 列
      { startRow: 0, endRow: 1, startCol: 0, endCol: 3 }, // 純橫向：1 列
      { startRow: 5, endRow: 7, startCol: 2, endCol: 3 }, // 直向：2 列
    ]
    expect(countVerticalMerges(merges)).toBe(2)
  })
})

describe('rowsToCards', () => {
  it('同標題（含直向合併造成的重複）併成一張卡、內容相接，回報 duplicateTitles', () => {
    const { cards, stats } = rowsToCards([
      ['問題', '答案'],
      ['退款流程', '第一步'],
      ['退款流程', '第二步'],
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0]!.title).toBe('退款流程')
    expect(cards[0]!.content).toContain('第一步')
    expect(cards[0]!.content).toContain('第二步')
    expect(stats.mergedRows).toBe(1)
    expect(stats.duplicateTitles).toEqual(['退款流程'])
  })

  it('第一欄空白的列被略過並計入 skippedNoTitle（不含在 cards）', () => {
    const { cards, stats } = rowsToCards([
      ['問題', '答案'],
      ['', '孤兒內容'], // 沒標題
      ['運費', '滿千免運'],
    ])
    expect(cards.map(c => c.title)).toEqual(['運費'])
    expect(stats.skippedNoTitle).toBe(1)
    expect(stats.rowCount).toBe(2)
  })

  it('沒答案的卡進 blankAnswerTitles；答案剛好等於問題不算沒答案（修 content===title 誤判）', () => {
    const { stats } = rowsToCards([
      ['問題', '答案'],
      ['只有標題', ''], // 真的沒答案
      ['營業時間', '營業時間'], // 答案剛好等於問題 → 有答案，不該誤報
    ])
    expect(stats.blankAnswerTitles).toEqual(['只有標題'])
  })
})

describe('sheetHealthWarnings', () => {
  const card = (title: string, content = '答案') => ({ title, content, tags: [] })
  const stats = (over: Partial<SheetImportStats> = {}): SheetImportStats => ({
    rowCount: 0,
    skippedNoTitle: 0,
    mergedRows: 0,
    truncatedByCap: false,
    duplicateTitles: [],
    blankAnswerTitles: [],
    ...over,
  })

  it('乾淨的表 → 沒有警告', () => {
    expect(sheetHealthWarnings([card('A'), card('B')], stats({ rowCount: 2 }))).toEqual([])
  })

  it('示範列沒替換 → 警告並列出標題', () => {
    const w = sheetHealthWarnings([card('退款多久?', '【示範答案,請替換】xxx'), card('B')], stats({ rowCount: 2 }))
    expect(w.some(x => x.includes('示範') && x.includes('退款多久?'))).toBe(true)
  })

  it('重複標題（已合併）→ 警告講「合併」', () => {
    const w = sheetHealthWarnings([card('運費')], stats({ duplicateTitles: ['運費'] }))
    expect(w.some(x => x.includes('重複') && x.includes('合併'))).toBe(true)
  })

  it('沒答案 → 警告', () => {
    const w = sheetHealthWarnings([card('退貨', '退貨')], stats({ blankAnswerTitles: ['退貨'] }))
    expect(w.some(x => x.includes('沒有答案'))).toBe(true)
  })

  it('達上限 → 警告含上限數字', () => {
    const w = sheetHealthWarnings([card('A')], stats({ truncatedByCap: true }))
    expect(w.some(x => x.includes(`超過 ${GSHEET_MAX_ROWS}`))).toBe(true)
  })

  it('有列因標題空白被略過 → 警告「被略過」而非「超過上限」', () => {
    const w = sheetHealthWarnings([card('A')], stats({ rowCount: 5, skippedNoTitle: 3 }))
    expect(w.some(x => x.includes('略過'))).toBe(true)
    expect(w.some(x => x.includes(`超過 ${GSHEET_MAX_ROWS}`))).toBe(false)
  })

  it('合併儲存格（第三參數 mergeCount）→ 警告', () => {
    const w = sheetHealthWarnings([card('A')], stats(), 2)
    expect(w.some(x => x.includes('合併儲存格'))).toBe(true)
  })

  it('列舉超過 3 個標題時用「等 N 列」收斂', () => {
    const cards = ['a', 'b', 'c', 'd', 'e'].map(t => card(t, '【示範答案,請替換】x'))
    const w = sheetHealthWarnings(cards, stats({ rowCount: 5 }))
    expect(w[0]).toContain('等 5 列')
  })
})

// 整合測試：注入假的 Sheets API（避開真的 Google API / 網路），驗證多分頁選擇 + 讀取 + 彙總的串接
describe('readGoogleSheetAsCards（多分頁彙總，注入假 API）', () => {
  const gridMerge = (r0: number, r1: number, c0: number, c1: number) => ({
    startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1,
  })
  type FakeSheet = { sheetId: number; title: string; merges?: unknown[]; values: string[][] }
  function makeApi(sheets: FakeSheet[]): SheetsApiFn {
    const meta = { sheets: sheets.map(s => ({ properties: { sheetId: s.sheetId, title: s.title }, merges: s.merges })) }
    return (async (path: string) => {
      const vm = path.match(/\/values\/([^?]+)/)
      if (vm) {
        const title = decodeURIComponent(vm[1]!)
        return { values: sheets.find(s => s.title === title)?.values ?? [] }
      }
      return meta // metadata 請求（帶 ?fields=）
    }) as SheetsApiFn
  }

  const faq: FakeSheet = { sheetId: 1, title: 'FAQ', values: [['問題', '答案'], ['退款多久?', '3 天'], ['運費?', '滿千免運']] }
  const guide: FakeSheet = { sheetId: 2, title: '使用說明', values: [['說明', '內容'], ['x', 'y']] }

  it('沒 gid + 有 FAQ 分頁 → 只讀 FAQ、跳過使用說明', async () => {
    const res = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([faq, guide]))
    expect(res.cards.map(c => c.title)).toEqual(['退款多久?', '運費?'])
    expect(res.sheetTitle).toBe('FAQ')
  })

  it('沒 gid + 沒 FAQ + 多個資料分頁 → 全部一起讀、跨分頁彙總', async () => {
    const a: FakeSheet = { sheetId: 1, title: '商品', values: [['品名', '說明'], ['除濕機', '省電']] }
    const b: FakeSheet = { sheetId: 2, title: '報價', values: [['項目', '價格'], ['安裝', '500']] }
    const res = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([a, b]))
    expect(res.cards.map(c => c.title)).toEqual(['除濕機', '安裝'])
    expect(res.sheetTitle).toBe('商品、報價')
    expect(res.stats.rowCount).toBe(2)
  })

  it('gid 指定 → 只讀那頁（即使是說明頁也照讀）', async () => {
    const res = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: '2' }, makeApi([faq, guide]))
    expect(res.cards.map(c => c.title)).toEqual(['x'])
    expect(res.sheetTitle).toBe('使用說明')
  })

  it('分頁內直向合併 → 展開後同標題併成一張卡、mergeCount 與 duplicateTitles 回報', async () => {
    const merged: FakeSheet = {
      sheetId: 1,
      title: 'FAQ',
      values: [['問題', '答案'], ['退款流程', '第一步'], ['', '第二步']],
      merges: [gridMerge(1, 3, 0, 1)], // 標題欄 A2:A3 直向合併（Google GridRange，end 不含）
    }
    const res = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([merged]))
    expect(res.cards.map(c => c.title)).toEqual(['退款流程'])
    expect(res.cards[0]!.content).toContain('第一步')
    expect(res.cards[0]!.content).toContain('第二步')
    expect(res.mergeCount).toBe(1)
    expect(res.stats.duplicateTitles).toEqual(['退款流程'])
  })

  it('整份分頁都沒有效資料 → 丟 422', async () => {
    const emptyish: FakeSheet = { sheetId: 1, title: '商品', values: [['只有表頭']] }
    await expect(readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([emptyish])))
      .rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('selectSheetsToRead gid 守門（經 readGoogleSheetAsCards）', () => {
  const makeApi = (sheets: Array<{ sheetId: number; title: string }>, values: string[][] = []): SheetsApiFn =>
    (async (path: string) => {
      if (path.includes('fields=')) {
        return { sheets: sheets.map(s => ({ properties: s })) } as never
      }
      return { values } as never
    }) as SheetsApiFn

  it('gid 對得上 → 只讀那頁（原行為）', async () => {
    const api = makeApi(
      [{ sheetId: 123, title: 'FAQ' }],
      [['問題', '答案'], ['運費', '滿千免運']],
    )
    const r = await readGoogleSheetAsCards({ spreadsheetId: 'x', gid: '123' }, api)
    expect(r.cards.length).toBe(1)
  })

  it('gid 對不上（分頁被刪除重建）→ 直接 422，不退回名稱猜測讀到別頁', async () => {
    // 沒守門的話會掉進名稱規則、把「使用說明」頁讀成知識 → 原 FAQ 卡整批被判「已不存在」刪光。
    // 退路頁給真實資料列：守門若被拿掉，這裡會「成功」讀出卡而不是丟錯——
    // 斷言必須綁「分頁已不存在」訊息，不能只看 422（空表守門也回 422，會假陽性）。
    const api = makeApi(
      [{ sheetId: 456, title: '使用說明' }],
      [['問題', '答案'], ['這是說明頁的列', '會被誤讀成知識卡']],
    )
    await expect(readGoogleSheetAsCards({ spreadsheetId: 'x', gid: '123' }, api))
      .rejects.toMatchObject({ statusCode: 422, statusMessage: expect.stringContaining('分頁已不存在') })
  })
})
