import { describe, expect, it } from 'vitest'

// google-sheets.ts 用 Nuxt 全域 createError 丟 4xx 錯誤；unit 測試環境沒有這個全域，補一個最小版。
;(globalThis as unknown as { createError?: unknown }).createError ??= (opts: { statusCode?: number; statusMessage?: string }) =>
  Object.assign(new Error(opts?.statusMessage ?? 'error'), opts)

import {
  countVerticalMerges,
  createCardCollector,
  expandVerticalMerges,
  GSHEET_MAX_ROWS,
  isInstructionSheetName,
  parseGoogleSheetUrl,
  probeGoogleSheetAccess,
  readGoogleSheetAsCards,
  rowsToCards,
  rowToCard,
  selectDataSheetNames,
  type SheetImportStats,
  sheetHealthWarnings,
  type SheetsApiFn,
} from './google-sheets'

/** 新貼進來的試算表那條路（readGoogleSheetAsCards 不給預設值，一定要講明新舊） */
const NEW_RULES = { legacy: false }

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
  // 這幾條新舊讀法結果一樣，兩種都跑
  for (const legacy of [true, false]) {
    describe(legacy ? '舊讀法' : '新讀法', () => {
      it('多欄表：標題=第一欄，內容=其餘欄表頭:值', () => {
        const card = rowToCard(headers, ['除濕機', '3990', '5', '附發票'], { legacy })
        expect(card).toEqual({
          title: '除濕機',
          content: '價格：3990\n庫存：5\n備註：附發票',
          tags: [],
        })
      })

      it('多欄表：空值欄略過', () => {
        const card = rowToCard(headers, ['除濕機', '3990', '', ''], { legacy })
        expect(card?.content).toBe('價格：3990')
      })

      it('兩欄表（FAQ）：內容=第二欄整段', () => {
        const card = rowToCard(['問題', '答案'], ['運費多少', '滿千免運，未滿 80 元'], { legacy })
        expect(card).toEqual({ title: '運費多少', content: '滿千免運，未滿 80 元', tags: [] })
      })

      it('第一欄空白 → 跳過該列（回 null）', () => {
        expect(rowToCard(headers, ['', '3990', '5', ''], { legacy })).toBeNull()
      })

      it('單欄 / 無其他內容 → 用標題自身當內容', () => {
        expect(rowToCard(['商品'], ['除濕機'], { legacy })?.content).toBe('除濕機')
      })
    })
  }

  it('列尾被剪掉的短列（Google 會剪）：舊讀法只取第二欄，新讀法照欄位名稱帶「容量」', () => {
    expect(rowToCard(['品名', '容量', '價格'], ['W1', '12L'], { legacy: true })?.content).toBe('12L')
    expect(rowToCard(['品名', '容量', '價格'], ['W1', '12L'], { legacy: false })?.content).toBe('容量：12L')
  })
})

describe('selectDataSheetNames / isInstructionSheetName', () => {
  const fresh = { legacy: false }
  it('每個非說明頁都讀（C-296）：範本的 FAQ 頁＋自己加的「工作表1」兩頁都要讀', () => {
    expect(selectDataSheetNames(['使用說明', 'FAQ', '工作表1'], fresh)).toEqual(['FAQ', '工作表1'])
  })

  it('舊來源（legacy）維持原規則：有 FAQ 分頁 → 只選 FAQ 頁，⛔ 不可以替已經在同步的表換規則', () => {
    expect(selectDataSheetNames(['使用說明', 'FAQ', '工作表1'], { legacy: true })).toEqual(['FAQ'])
    expect(selectDataSheetNames(['FAQ', '常見問題', '使用說明'], { legacy: true })).toEqual(['FAQ', '常見問題'])
  })

  it('沒 FAQ 分頁 → 全部「非說明」分頁（xlsx 與 gsheet 一致，不再只挑一個）', () => {
    expect(selectDataSheetNames(['使用說明', '商品資料', '報價'], fresh)).toEqual(['商品資料', '報價'])
  })

  it('整份都是說明類名稱 → 保底全讀', () => {
    expect(selectDataSheetNames(['使用說明', '填寫教學'], fresh)).toEqual(['使用說明', '填寫教學'])
  })

  it('資料分頁名含「說明」不會被誤跳（商品說明照選）', () => {
    expect(selectDataSheetNames(['使用說明', '商品說明'], fresh)).toEqual(['商品說明'])
  })

  it('Numbers 的「輸出摘要」不讀（各語言的名稱都認得）；保底全讀時也不讀它', () => {
    expect(selectDataSheetNames(['輸出摘要', '價目表', '常見問題'], fresh)).toEqual(['價目表', '常見問題'])
    expect(selectDataSheetNames(['Export Summary', 'Sheet 1'], fresh)).toEqual(['Sheet 1'])
    expect(selectDataSheetNames(['导出摘要', '書き出しの概要', '價目表'], fresh)).toEqual(['價目表'])
    expect(selectDataSheetNames(['輸出摘要', '使用說明'], fresh)).toEqual(['使用說明'])
    // 名稱要完全一樣才算：店家自己的「輸出摘要表」照讀
    expect(selectDataSheetNames(['輸出摘要表', '價目表'], fresh)).toEqual(['輸出摘要表', '價目表'])
  })

  it('舊來源照舊：不認輸出摘要（跟改版前選出來的一模一樣）', () => {
    expect(selectDataSheetNames(['輸出摘要', '價目表'], { legacy: true })).toEqual(['輸出摘要', '價目表'])
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

  it('只填一格的「問題」底下是純文字（沒問號沒數字）→ 分不出是不是表格標題，照跳；但要記下拿來當欄位名稱的那一列（C-303①）', () => {
    const r = rowsToCards([
      ['問題'],
      ['退貨流程', '寄回原廠', '附上發票'],
      ['換貨流程', '門市換', '帶收據'],
    ])
    expect(r.stats.titleRows).toEqual(['問題'])
    expect(r.stats.headerRows).toEqual(['退貨流程、寄回原廠、附上發票'])
    expect(sheetHealthWarnings(r.cards, r.stats)).toContain(
      '表格最上面的「問題」看起來是表格標題，改用下面那一列（退貨流程、寄回原廠、附上發票）當欄位名稱；如果那一列其實是第一筆資料，請在第 1 列每一欄都填上欄位名稱',
    )
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

  it('新讀法：同一頁先出現沒答案的那列、後面那列才有答案 → 直接換成答案，不留一行只有名稱的「W1」', () => {
    const r = rowsToCards([
      ['品名', '保固', '備註'],
      ['W1'],
      ['W1', '一年', '含運'],
    ])
    expect(r.cards).toEqual([{ title: 'W1', content: '保固：一年\n備註：含運', tags: [] }])
    expect(r.stats.blankAnswerTitles).toEqual([])
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
      '表格最上面的「2026 秋季價目表」看起來是表格標題，改用下面那一列當欄位名稱；如果那一列其實是第一筆資料，請在第 1 列每一欄都填上欄位名稱',
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
    const res = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([faq, guide]), NEW_RULES)
    expect(res.cards.map(c => c.title)).toEqual(['退款多久?', '運費?'])
    expect(res.sheetTitle).toBe('FAQ')
  })

  it('沒 gid + 沒 FAQ + 多個資料分頁 → 全部一起讀、跨分頁彙總', async () => {
    const a: FakeSheet = { sheetId: 1, title: '商品', values: [['品名', '說明'], ['除濕機', '省電']] }
    const b: FakeSheet = { sheetId: 2, title: '報價', values: [['項目', '價格'], ['安裝', '500']] }
    const res = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([a, b]), NEW_RULES)
    expect(res.cards.map(c => c.title)).toEqual(['除濕機', '安裝'])
    expect(res.sheetTitle).toBe('商品、報價')
    expect(res.stats.rowCount).toBe(2)
  })

  it('gid 指定 → 只讀那頁（即使是說明頁也照讀）', async () => {
    const res = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: '2' }, makeApi([faq, guide]), NEW_RULES)
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
    const res = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([merged]), NEW_RULES)
    expect(res.cards.map(c => c.title)).toEqual(['退款流程'])
    expect(res.cards[0]!.content).toContain('第一步')
    expect(res.cards[0]!.content).toContain('第二步')
    expect(res.mergeCount).toBe(1)
    expect(res.stats.duplicateTitles).toEqual(['退款流程'])
  })

  it('整份分頁都沒有效資料 → 丟 422', async () => {
    const emptyish: FakeSheet = { sheetId: 1, title: '商品', values: [['只有表頭']] }
    await expect(readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([emptyish]), NEW_RULES))
      .rejects.toMatchObject({ statusCode: 422 })
  })

  it('⛔ 不同分頁同一個標題併成一張（以前建兩張同名卡，同步時一頁蓋掉另一頁）、列進重複提醒', async () => {
    const price: FakeSheet = { sheetId: 1, title: '價目表', values: [['品名', '價格'], ['W1', '12,900']] }
    const spec: FakeSheet = { sheetId: 2, title: '規格', values: [['品名', '容量'], ['W1', '12L']] }
    const res = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([price, spec]), NEW_RULES)
    expect(res.cards).toEqual([{ title: 'W1', content: '12,900\n12L', tags: [] }])
    expect(res.stats.duplicateTitles).toEqual(['W1'])
  })

  it('有讀但一條都沒整理出來的分頁要回報（那頁的內容沒收進來）', async () => {
    // 只有欄位名稱、還沒填資料的分頁
    const notes: FakeSheet = { sheetId: 2, title: '新品（還沒填）', values: [['品名', '價格']] }
    const res = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([faq, notes]), NEW_RULES)
    expect(res.emptySheets).toEqual(['新品（還沒填）'])
  })

  it('舊來源（legacy）照舊：有 FAQ 頁就只讀它（不會突然多讀別頁）', async () => {
    const price: FakeSheet = { sheetId: 3, title: '價目表', values: [['品名', '價格'], ['W1', '12,900']] }
    const legacy = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([faq, price]), { legacy: true })
    expect(legacy.cards.map(c => c.title)).toEqual(['退款多久?', '運費?'])
    const fresh = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([faq, price]), NEW_RULES)
    expect(fresh.cards.map(c => c.title)).toEqual(['退款多久?', '運費?', 'W1'])
  })

  it('只有一欄的分頁不算表格、列進「沒收進來」（跟 Excel 同一把尺，C-303②）；舊來源照舊讀', async () => {
    // 店家拿來記事的分頁：A 欄一路寫下去，B 欄以後全空（Sheets API 會把尾端空格省掉）
    const memo: FakeSheet = { sheetId: 4, title: '備忘', values: [['週一進貨'], ['週三盤點'], ['', ''], ['月底對帳']] }
    const fresh = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([faq, memo]), NEW_RULES)
    expect(fresh.cards.map(c => c.title)).toEqual(['退款多久?', '運費?'])
    expect(fresh.emptySheets).toEqual(['備忘'])

    // 已經在同步的舊表：換規則＝下一輪同步把那幾張卡整批刪掉，所以舊表一張都不能少
    const before = await readGoogleSheetAsCards({ spreadsheetId: 's', gid: '4' }, makeApi([faq, memo]), { legacy: true })
    expect(before.emptySheets).toEqual([])
    expect(before.cards.length).toBeGreaterThan(0)
  })

  it('只有一欄、但整頁就這一頁 → 新表丟 422（跟只有表頭一樣）', async () => {
    const memo: FakeSheet = { sheetId: 4, title: '備忘', values: [['週一進貨'], ['週三盤點']] }
    await expect(readGoogleSheetAsCards({ spreadsheetId: 's', gid: null }, makeApi([memo]), NEW_RULES))
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
    const r = await readGoogleSheetAsCards({ spreadsheetId: 'x', gid: '123' }, api, NEW_RULES)
    expect(r.cards.length).toBe(1)
  })

  it('gid 對不上（分頁被刪除重建）→ 直接 422，不退回名稱猜測讀到別頁（舊讀法同）', async () => {
    const api = makeApi([{ sheetId: 456, title: '使用說明' }], [['問題', '答案'], ['x', 'y']])
    await expect(readGoogleSheetAsCards({ spreadsheetId: 'x', gid: '123' }, api, { legacy: true }))
      .rejects.toMatchObject({ statusCode: 422, statusMessage: expect.stringContaining('分頁已不存在') })
  })

  it('gid 對不上（分頁被刪除重建）→ 直接 422，不退回名稱猜測讀到別頁', async () => {
    // 沒守門的話會掉進名稱規則、把「使用說明」頁讀成知識 → 原 FAQ 卡整批被判「已不存在」刪光。
    // 退路頁給真實資料列：守門若被拿掉，這裡會「成功」讀出卡而不是丟錯——
    // 斷言必須綁「分頁已不存在」訊息，不能只看 422（空表守門也回 422，會假陽性）。
    const api = makeApi(
      [{ sheetId: 456, title: '使用說明' }],
      [['問題', '答案'], ['這是說明頁的列', '會被誤讀成知識卡']],
    )
    await expect(readGoogleSheetAsCards({ spreadsheetId: 'x', gid: '123' }, api, NEW_RULES))
      .rejects.toMatchObject({ statusCode: 422, statusMessage: expect.stringContaining('分頁已不存在') })
  })
})

// ── 2026-10-11 審查修正 ─────────────────────────────────────────────

/** 假的 Sheets API：metadata 給分頁清單，values 照分頁名回（範圍「頁名!A1:Z20」也認得） */
type Tab = { title: string, values: string[][], merges?: unknown[] }
function tabsApi(tabs: Tab[], calls: string[] = []): SheetsApiFn {
  return (async (path: string) => {
    if (path.includes('?fields=')) {
      return { sheets: tabs.map((t, i) => ({ properties: { sheetId: i + 1, title: t.title }, merges: t.merges })) }
    }
    const title = decodeURIComponent(path.split('/values/')[1]!.split('?')[0]!).split('!')[0]!
    calls.push(title)
    return { values: tabs.find(t => t.title === title)?.values ?? [] }
  }) as SheetsApiFn
}
const ref = { spreadsheetId: 's', gid: null }

describe('欄位名稱認不出來也不掉資料（finding 2）', () => {
  it('「2026 售價」這種帶年份的欄位名稱認得出來（以前有數字就不認，價格整欄不見）', () => {
    const r = rowsToCards([
      ['2026 秋季價目表'], // Google 會把列尾空格剪掉：標題列只剩一格
      ['品名', '容量', '2026 售價'],
      ['W1', '12L', '12,900'],
    ])
    expect(r.cards).toEqual([{ title: 'W1', content: '容量：12L\n2026 售價：12,900', tags: [] }])
    expect(r.stats.titleRows).toEqual(['2026 秋季價目表'])
  })

  it('比較長的英文欄位名稱（Product Name (English)）也認得', () => {
    const r = rowsToCards([
      ['Price list'],
      ['Product Name (English)', 'Capacity', 'Price'],
      ['W1', '12L', '12900'],
    ])
    expect(r.cards).toEqual([{ title: 'W1', content: 'Capacity：12L\nPrice：12900', tags: [] }])
  })

  it('⛔ 真的認不出欄位名稱時，一列有幾欄看整張表最寬那列：只剩一格的標題列不可以讓後面的欄位整欄消失', () => {
    // 「Q1 售價」有年份以外的數字 → 不認成欄位名稱，退回拿第 1 列當欄位名稱（只有一格）
    const r = rowsToCards([
      ['2026 秋季價目表'],
      ['品名', '容量', 'Q1 售價'],
      ['W1', '12L', '12,900'],
    ])
    const w1 = r.cards.find(c => c.title === 'W1')!
    expect(w1.content).toBe('12L\n12,900') // 以前（兩欄模式）只剩「12L」，價格不見
    expect(r.stats.titleRows).toEqual([])
  })

  it('⛔ 第一筆資料帶型號數字（W1 mini｜小台｜白色）不可以被當成欄位名稱吃掉', () => {
    const r = rowsToCards([
      ['新品'],
      ['W1 mini', '小台', '白色'],
      ['W2', '大台', '黑色'],
    ])
    expect(r.cards.map(c => c.title)).toContain('W1 mini')
    expect(r.stats.titleRows).toEqual([])
  })

  it('流水號那欄的欄位名稱只寫一個「#」也認得（2026-10-11 拿本機真的試算表比對抓到：整列不認、多一張叫「#」的卡）', () => {
    const r = rowsToCards([
      ['維修服務 / 價目一覽'],
      ['#', '品牌', '型號 / 尺寸', '保固'],
      ['1', 'Apple', 'iPhone 15 / 15 Plus', '一年'],
      ['2', 'Sony', 'WH-1000XM5', '兩年'],
      ['3', 'Dyson', 'V15', '兩年'],
    ])
    expect(r.stats.titleRows).toEqual(['維修服務 / 價目一覽'])
    expect(r.cards[0]).toMatchObject({ title: 'Apple', content: '品牌：Apple\n型號 / 尺寸：iPhone 15 / 15 Plus\n保固：一年' })
  })
})

describe('第一欄是流水號（1、2、3…）→ 改用下一欄當名稱（2026-10-11）', () => {
  const table = (rows: string[][]) => rowsToCards([['#', '品名', '價格'], ...rows])

  it('名稱用第二欄（內容照樣留著，不少一欄），而且要講出來', () => {
    const r = table([['1', '耶加雪菲', '450'], ['2', '曼特寧', '420'], ['3', '藝伎', '980']])
    expect(r.cards.map(c => c.title)).toEqual(['耶加雪菲', '曼特寧', '藝伎'])
    expect(r.cards[0]!.content).toBe('品名：耶加雪菲\n價格：450')
    expect(r.stats.serialColumns).toEqual(['#'])
    expect(sheetHealthWarnings(r.cards, r.stats).join('')).toContain('第一欄「#」是流水號')
  })

  it('⛔ 第二欄有重複（同一個平台好幾列）不可以拿來直接當名稱——會把不同列併成一條：改用「序號. 名稱」', () => {
    const r = rowsToCards([['項次', '平台', '網址'], ['1', '蝦皮購物', 'a.example'], ['2', '官網', 'b.example'], ['3', '蝦皮購物', 'c.example']])
    expect(r.cards.map(c => c.title)).toEqual(['1. 蝦皮購物', '2. 官網', '3. 蝦皮購物'])
    expect(r.stats.mergedRows).toBe(0)
  })

  it('表格底下夾一列「註」也認得出流水號；那一列照舊（不丟）', () => {
    const r = table([['1', '耶加雪菲', '450'], ['2', '曼特寧', '420'], ['3', '藝伎', '980'], ['4', '肯亞', '520'], ['註：價格含稅', '', '']])
    expect(r.cards.map(c => c.title)).toEqual(['耶加雪菲', '曼特寧', '藝伎', '肯亞', '註：價格含稅'])
  })

  it('⛔ 貨號（1001、1002…）不是流水號：照舊拿來當名稱', () => {
    const r = table([['1001', '耶加雪菲', '450'], ['1002', '曼特寧', '420'], ['1003', '藝伎', '980']])
    expect(r.cards.map(c => c.title)).toEqual(['1001', '1002', '1003'])
    expect(r.stats.serialColumns).toBeUndefined()
  })

  it('⛔ 下一欄也是數字（換了也沒比較好）就不換；不到 3 列也不猜', () => {
    expect(rowsToCards([['#', '價格', '數量'], ['1', '450', '2'], ['2', '420', '1'], ['3', '980', '5']]).cards.map(c => c.title)).toEqual(['1', '2', '3'])
    expect(table([['1', '耶加雪菲', '450'], ['2', '曼特寧', '420']]).cards.map(c => c.title)).toEqual(['1', '2'])
  })

  it('⛔ 舊的 Google 試算表來源照舊讀（同步不能因為改讀法就改寫知識）', () => {
    const r = rowsToCards([['#', '品名', '價格'], ['1', '耶加雪菲', '450'], ['2', '曼特寧', '420'], ['3', '藝伎', '980']], { legacy: true })
    expect(r.cards.map(c => c.title)).toEqual(['1', '2', '3'])
  })

  it('⛔ 第一筆資料是一句話（有逗號）也不當欄位名稱', () => {
    const r = rowsToCards([
      ['常見問題'],
      ['退貨', '收到七天內可退，需附發票', '偏遠地區另計'],
      ['運費', '滿千免運', ''],
    ])
    expect(r.cards.map(c => c.title)).toEqual(['退貨', '運費'])
  })
})

describe('跨分頁合併看有沒有答案（finding 3）', () => {
  const blankThenAnswered = () => {
    const a = rowsToCards([['品名', '容量', '價格'], ['W1'], ['W2', '20L', '19,900']])
    const b = rowsToCards([['品名', '保固', '備註'], ['W1', '一年', '含運'], ['W3', '兩年', '']])
    return { a, b }
  }

  it('先遇到沒答案的那頁、後面那頁才有答案 → 內容換成答案（不留一行「W1」），也不再報「沒答案」', () => {
    const { a, b } = blankThenAnswered()
    const c = createCardCollector({ legacy: false })
    c.addSheet(a.cards, a.stats, '價目表')
    c.addSheet(b.cards, b.stats, '規格表')
    expect(c.cards.find(x => x.title === 'W1')!.content).toBe('保固：一年\n備註：含運')
    expect(c.stats.blankAnswerTitles).toEqual([])
    expect(c.stats.duplicateTitles).toEqual(['W1'])
  })

  it('順序反過來（先有答案、後面那頁沒答案）→ 不會在後面多接一行「W1」', () => {
    const { a, b } = blankThenAnswered()
    const c = createCardCollector({ legacy: false })
    c.addSheet(b.cards, b.stats, '規格表')
    c.addSheet(a.cards, a.stats, '價目表')
    expect(c.cards.find(x => x.title === 'W1')!.content).toBe('保固：一年\n備註：含運')
    expect(c.stats.blankAnswerTitles).toEqual([])
  })

  it('兩頁都沒答案 → 還是報沒答案（只報一次）', () => {
    const a = rowsToCards([['品名', '容量', '價格'], ['W1'], ['W2', '20L', '19,900']])
    const b = rowsToCards([['品名', '保固', '備註'], ['W1'], ['W3', '兩年', '']])
    const c = createCardCollector({ legacy: false })
    c.addSheet(a.cards, a.stats)
    c.addSheet(b.cards, b.stats)
    expect(c.stats.blankAnswerTitles).toEqual(['W1'])
    expect(c.cards.find(x => x.title === 'W1')!.content).toBe('W1')
  })

  it('⛔ 舊讀法照舊：不跨頁合併（W1 兩張，跟改版前一樣，同步只認第一張）', async () => {
    const tabs = [
      { title: '價目表', values: [['品名', '價格'], ['W1', '12,900'], ['W2', '15,900']] },
      { title: '規格表', values: [['品名', '容量'], ['W1', '12L'], ['W3', '20L']] },
    ]
    const legacy = await readGoogleSheetAsCards(ref, tabsApi(tabs), { legacy: true })
    expect(legacy.cards).toEqual([
      { title: 'W1', content: '12,900', tags: [] },
      { title: 'W2', content: '15,900', tags: [] },
      { title: 'W1', content: '12L', tags: [] },
      { title: 'W3', content: '20L', tags: [] },
    ])
    expect(legacy.stats.duplicateTitles).toEqual([])
    const fresh = await readGoogleSheetAsCards(ref, tabsApi(tabs), NEW_RULES)
    expect(fresh.cards.find(c => c.title === 'W1')!.content).toBe('12,900\n12L')
  })
})

describe('收滿 150 條之後同名的照樣併（finding 4）', () => {
  const many = (n: number, prefix = 'Q') => [['問題', '答案'], ...Array.from({ length: n }, (_, i) => [`${prefix}${i}`, `A${i}`])]

  it('跨分頁：滿了之後新的名稱不收，同名的還是併進去；沒收的條數講得出來', () => {
    const c = createCardCollector({ legacy: false })
    const s1 = rowsToCards(many(GSHEET_MAX_ROWS))
    c.addSheet(s1.cards, s1.stats)
    const s2 = rowsToCards([['問題', '答案'], ['NEW', 'x'], ['Q1', '第二頁補充']])
    c.addSheet(s2.cards, s2.stats)
    expect(c.cards).toHaveLength(GSHEET_MAX_ROWS)
    expect(c.cards.find(x => x.title === 'Q1')!.content).toBe('A1\n第二頁補充')
    expect(c.stats.truncatedByCap).toBe(true)
    expect(c.stats.droppedByCap).toBe(1)
    expect(sheetHealthWarnings(c.cards, c.stats).some(w => w.includes('後面還有 1 條沒收進來'))).toBe(true)
  })

  it('滿了之後後面的分頁只有同名的列 → 不算超過上限（以前一滿就報、而且後面那頁的內容沒了）', () => {
    const c = createCardCollector({ legacy: false })
    const s1 = rowsToCards(many(GSHEET_MAX_ROWS))
    c.addSheet(s1.cards, s1.stats)
    const s2 = rowsToCards([['問題', '答案'], ['Q3', '補充']])
    c.addSheet(s2.cards, s2.stats)
    expect(c.stats.truncatedByCap).toBe(false)
    expect(c.cards.find(x => x.title === 'Q3')!.content).toBe('A3\n補充')
  })

  it('同一頁：滿了之後同名的列照樣併；沒收進來那一項的延續列不可以接到上一個收進來的項目', () => {
    const rows = [
      ['品名', '容量', '價格'],
      ...Array.from({ length: GSHEET_MAX_ROWS }, (_, i) => [`W${i}`, `${i}L`, '']),
      ['NEW', '1L', '100'],
      ['', '濾網', '50'], // NEW 的延續列：NEW 沒收，這列也不收（⛔ 不可以接到 W149）
      ['W0', '', '999'],
    ]
    const r = rowsToCards(rows)
    expect(r.cards).toHaveLength(GSHEET_MAX_ROWS)
    expect(r.cards[0]!.content).toBe('容量：0L\n價格：999')
    expect(r.cards[GSHEET_MAX_ROWS - 1]!.content).toBe(`容量：${GSHEET_MAX_ROWS - 1}L`)
    expect(r.stats.truncatedByCap).toBe(true)
    expect(r.stats.cappedOut).toEqual(['new'])
  })

  it('Google 試算表：滿了也照樣讀後面的分頁，把同名的列併進來', async () => {
    const tabs = [
      { title: 'A', values: many(GSHEET_MAX_ROWS) },
      { title: 'B', values: [['問題', '答案'], ['Q0', 'B 頁的補充'], ['另一題', 'y']] },
    ]
    const res = await readGoogleSheetAsCards(ref, tabsApi(tabs), NEW_RULES)
    expect(res.cards.find(c => c.title === 'Q0')!.content).toBe('A0\nB 頁的補充')
    expect(res.stats.droppedByCap).toBe(1)
  })
})

describe('空白分頁不提醒（finding 5）', () => {
  it('整頁空白的「Sheet2」不列進「沒整理出來」；有字卻整理不出來的封面才列', async () => {
    const tabs = [
      { title: '封面', values: [['2026 型錄']] },
      { title: 'Sheet2', values: [] },
      { title: '空白列', values: [[], ['', '  ']] },
      { title: '價目表', values: [['品名', '價格'], ['W1', '100']] },
    ]
    const res = await readGoogleSheetAsCards(ref, tabsApi(tabs), NEW_RULES)
    expect(res.emptySheets).toEqual(['封面'])
  })
})

describe('Numbers 的輸出摘要（finding 8）', () => {
  const summary: Tab = {
    title: '輸出摘要',
    values: [['此文件從 Numbers 輸出。已將每個表格轉換為不同的 Excel 工作表。'], [], ['Numbers 工作表名稱', 'Numbers 表格名稱', 'Excel 工作表名稱'], ['價目表', '表格 1', '價目表']],
  }
  const price: Tab = { title: '價目表', values: [['品名', '價格'], ['W1', '12,900']] }

  it('新讀法：不讀、不算「看起來是使用說明」，改成講「Numbers 自動加的」', async () => {
    const res = await readGoogleSheetAsCards(ref, tabsApi([summary, price]), NEW_RULES)
    expect(res.cards.map(c => c.title)).toEqual(['W1'])
    expect(res.skippedSheets).toEqual([])
    expect(res.stats.exportSummarySheets).toEqual(['輸出摘要'])
    expect(sheetHealthWarnings(res.cards, res.stats)).toContain('略過「輸出摘要」分頁（Numbers 輸出時自動加的說明頁，不是資料）')
  })

  it('舊讀法照舊（改版前會讀它，就照讀，不改變已在同步的表）', async () => {
    const res = await readGoogleSheetAsCards(ref, tabsApi([summary, price]), { legacy: true })
    expect(res.cards.map(c => c.title)).toContain('價目表')
    expect(res.stats.exportSummarySheets).toBeUndefined()
  })
})

describe('延續列講出第幾列併到哪一項（finding 9）', () => {
  it('一列：講列號（試算表上真正的列號，前面的空白列也算）、用第一欄的欄位名稱', async () => {
    const tabs = [{ title: '價目表', values: [[], ['品名', '容量', '價格'], ['W1', '12L', '12,900'], ['W2', '20L', '19,900'], ['', '濾網（2 入）', '990']] }]
    const res = await readGoogleSheetAsCards(ref, tabsApi(tabs), NEW_RULES)
    expect(res.cards.find(c => c.title === 'W2')!.content).toBe('容量：20L\n價格：19,900\n容量：濾網（2 入）\n價格：990')
    expect(sheetHealthWarnings(res.cards, res.stats)).toContain('第 5 列沒有「品名」，已併到上一項「W2」；不對的話請補上再匯入一次')
  })

  it('好幾列：最多列 3 個例子、後面用「等」，總數照實講', () => {
    const r = rowsToCards([
      ['品名', '容量', '價格'],
      ['W1', '12L', '1'], ['', 'a', '2'], ['', 'b', '3'],
      ['W2', '20L', '4'], ['', 'c', '5'], ['', 'd', '6'],
    ])
    expect(sheetHealthWarnings(r.cards, r.stats)).toContain(
      '有 4 列沒有「品名」，已各自併到上一項：第 3 列併到「W1」、第 4 列併到「W1」、第 6 列併到「W2」等；不對的話請補上再匯入一次',
    )
  })

  it('收了好幾個分頁時，列號前面帶分頁名稱（不然對不到是哪一頁的第幾列）', async () => {
    const tabs = [
      { title: '常見問題', values: [['問題', '答案'], ['退貨?', '7 天內']] },
      { title: '價目表', values: [['品名', '容量', '價格'], ['W1', '12L', '1'], ['', '濾網', '2']] },
    ]
    const res = await readGoogleSheetAsCards(ref, tabsApi(tabs), NEW_RULES)
    expect(sheetHealthWarnings(res.cards, res.stats)).toContain('「價目表」第 3 列沒有「品名」，已併到上一項「W1」；不對的話請補上再匯入一次')
  })

  it('欄位名稱認不出來時不硬套名稱，講「第一欄是空的」', () => {
    const r = rowsToCards([['價目表'], ['W1', '12L', '1'], ['', '濾網', '2']])
    expect(sheetHealthWarnings(r.cards, r.stats)).toContain('第 3 列第一欄是空的，已併到上一項「W1」；不對的話請補上再匯入一次')
  })
})

describe('probeGoogleSheetAccess（finding 6）', () => {
  const empty = (title: string): Tab => ({ title, values: [['封面']] })
  const faq: Tab = { title: 'FAQ', values: [['問題', '答案'], ['退貨?', '7 天內']] }

  it('複製範本、FAQ 頁排在好幾頁封面後面 → 先看 FAQ 頁，亮綠燈', async () => {
    const calls: string[] = []
    const res = await probeGoogleSheetAccess(ref, tabsApi([empty('封面'), empty('目錄'), empty('品牌故事'), empty('聯絡我們'), faq], calls))
    expect(res).toMatchObject({ hasData: true, sheetTitle: 'FAQ', checkedTitles: ['FAQ'] })
    expect(calls).toEqual(['FAQ'])
  })

  it('有上限：最多看 5 頁，回報真的看過哪幾頁（講「沒資料」只能講這幾頁）', async () => {
    const tabs = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(empty)
    const res = await probeGoogleSheetAccess(ref, tabsApi(tabs))
    expect(res.hasData).toBe(false)
    expect(res.checkedTitles).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(res.sheetTitles).toHaveLength(7)
  })

  it('Numbers 的輸出摘要不算一頁（不看、也不列進會讀的分頁）', async () => {
    const res = await probeGoogleSheetAccess(ref, tabsApi([{ title: '輸出摘要', values: [['此文件從 Numbers 輸出']] }, faq]))
    expect(res.sheetTitles).toEqual(['FAQ'])
  })

  it('⛔ 只有一欄的分頁 → 不打綠勾、點名是「只有一欄」（以前打勾，按下整理才撞「沒有足夠資料」，2026-10-13 /code-review）', async () => {
    const listOnly: Tab = { title: '常見問題', values: [['退貨多久？'], ['運費多少？'], ['可以分期嗎？']] }
    const res = await probeGoogleSheetAccess(ref, tabsApi([listOnly]))
    expect(res).toMatchObject({ hasData: false, narrowTitles: ['常見問題'] })
    // 匯入那邊同一把尺：一樣整理不出來，錯誤訊息點名那一頁、講要兩欄
    await expect(readGoogleSheetAsCards(ref, tabsApi([listOnly]), NEW_RULES))
      .rejects.toMatchObject({ statusCode: 422, statusMessage: expect.stringContaining('「常見問題」只有一欄') })
  })

  it('封面頁（只有一格標題）不算「只有一欄」——那是沒資料，講法不一樣', async () => {
    const res = await probeGoogleSheetAccess(ref, tabsApi([empty('封面'), faq]))
    expect(res).toMatchObject({ hasData: true, narrowTitles: [] })
  })
})
