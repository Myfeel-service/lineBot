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
  it('每個非說明頁都讀（C-296）：範本的 FAQ 頁＋自己加的「工作表1」兩頁都要讀', () => {
    expect(selectDataSheetNames(['使用說明', 'FAQ', '工作表1'])).toEqual(['FAQ', '工作表1'])
  })

  it('舊來源（faqPriority）維持原規則：有 FAQ 分頁 → 只選 FAQ 頁，⛔ 不可以替已經在同步的表換規則', () => {
    expect(selectDataSheetNames(['使用說明', 'FAQ', '工作表1'], { faqPriority: true })).toEqual(['FAQ'])
    expect(selectDataSheetNames(['FAQ', '常見問題', '使用說明'], { faqPriority: true })).toEqual(['FAQ', '常見問題'])
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

  it('第一欄空白、而且上面沒有列可以接 → 照舊略過並計入 skippedNoTitle', () => {
    const { cards, stats } = rowsToCards([
      ['問題', '答案'],
      ['', '孤兒內容'], // 沒標題
      ['運費', '滿千免運'],
    ])
    expect(cards.map(c => c.title)).toEqual(['運費'])
    expect(stats.skippedNoTitle).toBe(1)
    expect(stats.rowCount).toBe(2)
  })

  it('第一欄空白的列＝上一列的延續：併進同一條、記 continuedRows，⛔ 不算「重複的問題」', () => {
    const { cards, stats } = rowsToCards([
      ['品名', '規格', '值'],
      ['W1 REGEN 改', '容量', '12L'],
      ['', '重量', '8kg'],
      ['W1 mini', '容量', '6L'],
    ])
    expect(cards.map(c => c.title)).toEqual(['W1 REGEN 改', 'W1 mini'])
    expect(cards[0]!.content).toBe('規格：容量\n值：12L\n規格：重量\n值：8kg')
    expect(stats.continuedRows).toBe(1)
    expect(stats.skippedNoTitle).toBe(0)
    expect(stats.duplicateTitles).toEqual([])
  })

  it('最上面一行表格標題（下一列三欄以上）→ 跳過，欄位名稱用下一列；跳過的標題要記下來講', () => {
    const { cards, stats } = rowsToCards([
      ['2026 秋季價目表', '', ''],
      ['品名', '容量', '價格'],
      ['W1 REGEN 改', '12L', '12,900'],
    ])
    expect(cards).toEqual([{ title: 'W1 REGEN 改', content: '容量：12L\n價格：12,900', tags: [] }])
    expect(stats.titleRows).toEqual(['2026 秋季價目表'])
  })

  it('⛔ 兩欄表一律不跳標題列：第一題不可以被當成欄位名稱吃掉（2026-10-10 審查實測）', () => {
    // 大標題下面直接就是資料：以前（合併就跳）會把「退貨多久?」當欄位名稱、第一題整題不見
    const r = rowsToCards([
      ['常見問題 Q&A'],
      ['退貨多久?', '7 天內'],
      ['運費?', '80 元'],
    ])
    expect(r.cards.map(c => c.title)).toEqual(['退貨多久?', '運費?'])
    expect(r.stats.titleRows).toEqual([])
  })

  it('兩行標題（標題＋單位）都跳過，欄位名稱用第 3 列', () => {
    const r = rowsToCards([
      ['2026 秋季價目表'],
      ['單位：新台幣'],
      ['品名', '容量', '價格'],
      ['W1 mini', '6L', '8,990'],
    ])
    expect(r.stats.titleRows).toEqual(['2026 秋季價目表', '單位：新台幣'])
    expect(r.cards).toEqual([{ title: 'W1 mini', content: '容量：6L\n價格：8,990', tags: [] }])
  })

  it('⛔ 下一列像資料（有問號、有數字）就不跳：只填一格的「問題」表頭底下的第一題不可以被吃掉', () => {
    const r = rowsToCards([
      ['問題'],
      ['退貨?', '7天內', '需發票'],
      ['運費?', '80元', '滿千免運'],
    ])
    expect(r.stats.titleRows).toEqual([])
    expect(r.cards.map(c => c.title)).toEqual(['退貨?', '運費?'])
  })

  it('延續列只加「還沒有的那幾行」：⛔「價格：12」不可以因為上面有「價格：12,900」就被丟掉', () => {
    const r = rowsToCards([
      ['品名', '說明', '價格'],
      ['W1', '主機', '12,900'],
      ['', '', '12'],
    ])
    expect(r.cards[0]!.content).toBe('說明：主機\n價格：12,900\n價格：12')
  })

  it('舊來源（legacy）一模一樣照舊讀：第 1 列當欄位名稱、第一欄空白略過、短列只取第二欄', () => {
    const rows = [
      ['2026 秋季價目表', '', ''],
      ['品名', '容量', '價格'],
      ['W1', '12L', '12,900'],
      ['', '重量', '8kg'],
    ]
    const r = rowsToCards(rows, { legacy: true })
    // 跟改版前同一個結果（含那張叫「品名」的怪卡）——舊來源的同步不可以因為改版而改寫知識
    expect(r.cards.map(c => c.title)).toEqual(['品名', 'W1'])
    expect(r.stats.skippedNoTitle).toBe(1)
    expect(r.stats.titleRows).toEqual([])
    expect(r.stats.continuedRows).toBe(0)
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
    titleRows: [],
    continuedRows: 0,
    ...over,
  })

  it('跳過的表格標題、接到上一列的延續列都要講出來（C-296：猜的要說）', () => {
    const w = sheetHealthWarnings([card('W1')], stats({ rowCount: 3, titleRows: ['2026 秋季價目表'], continuedRows: 2 }))
    expect(w).toEqual([
      '表格最上面的「2026 秋季價目表」看起來是表格標題，欄位名稱改用下面那一列；不對的話請把欄位名稱移到第 1 列',
      '有 2 列第一欄空白，已當成上一列的延續、併進同一條（例：同一個商品的第二行規格）',
    ])
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

  it('⛔ 不同分頁同一個標題併成一張（以前建兩張同名卡，同步時一頁蓋掉另一頁）、列進重複提醒', async () => {
    const price: FakeSheet = { sheetId: 1, title: '價目表', values: [['品名', '價格'], ['W1', '12,900']] }
    const spec: FakeSheet = { sheetId: 2, title: '規格', values: [['品名', '容量'], ['W1', '12L']] }
    const res = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([price, spec]))
    expect(res.cards).toEqual([{ title: 'W1', content: '12,900\n12L', tags: [] }])
    expect(res.stats.duplicateTitles).toEqual(['W1'])
  })

  it('有讀但一條都沒整理出來的分頁要回報（那頁的內容沒收進來）', async () => {
    // 只有欄位名稱、還沒填資料的分頁
    const notes: FakeSheet = { sheetId: 2, title: '新品（還沒填）', values: [['品名', '價格']] }
    const res = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([faq, notes]))
    expect(res.emptySheets).toEqual(['新品（還沒填）'])
  })

  it('舊來源（legacy）照舊：有 FAQ 頁就只讀它（不會突然多讀別頁）', async () => {
    const price: FakeSheet = { sheetId: 3, title: '價目表', values: [['品名', '價格'], ['W1', '12,900']] }
    const legacy = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([faq, price]), { legacy: true })
    expect(legacy.cards.map(c => c.title)).toEqual(['退款多久?', '運費?'])
    const fresh = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([faq, price]))
    expect(fresh.cards.map(c => c.title)).toEqual(['退款多久?', '運費?', 'W1'])
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
