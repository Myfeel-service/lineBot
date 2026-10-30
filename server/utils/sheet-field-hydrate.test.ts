import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `C-423`：模組裡「試算表的一格」送出前換成知識卡上現在寫的。
 * 釘四件事：①換成最新的（改試算表＝選單跟 AI 一起變）②換不到用存檔當時的、⛔ 不送原字也不送空白
 * ③我們自己的 `sheetSnapshots` 不可以送給 LINE ④沒用到的模組不多讀資料庫。
 */

const SOURCES: Array<Record<string, any>> = []
const CARDS: Record<string, Array<{ title: string, content: string, isOverview?: boolean }>> = {}
const getDb = vi.fn()

vi.mock('./firebase', () => ({ getDb: () => getDb() }))
vi.mock('./ai-knowledge-sources', () => ({
  KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources',
  listChunksBySource: vi.fn(async (_db: unknown, _ws: string, sourceId: string) => (CARDS[sourceId] ?? []).map(c => ({ isOverview: false, ...c }))),
}))
/** `C-432`／`C-434`：每份表的商品清單（改了名的商品，舊名字在 aliases） */
const REGISTRIES: Record<string, any> = {}
vi.mock('./sheet-products', () => ({
  loadSheetProductRegistry: vi.fn(async (_db: unknown, _ws: string, sourceId: string) => REGISTRIES[sourceId] ?? null),
  updateSheetProductRegistry: vi.fn(),
}))

const { hydrateSheetFields, attachSheetSnapshots, loadSheetRows } = await import('./sheet-field-hydrate')
const { sheetFieldToken } = await import('~~/shared/sheet-field')

const HEADERS = ['出貨時間', '商品頁面']
const GIARETTI = 'Giaretti 珈樂堤《小滑手》全自動義式咖啡機 GL-5680'
const SHIP = sheetFieldToken({ row: GIARETTI, field: '出貨時間' })
const PAGE = sheetFieldToken({ row: GIARETTI, field: '商品頁面' })

function fakeDb() {
  return {
    collection: () => ({
      where: () => ({
        where: () => ({
          get: async () => ({
            docs: SOURCES.map(s => ({ id: s.id, get: (f: string) => (f === 'createdAt' ? { toMillis: () => s.createdAt ?? 0 } : s[f]) })),
          }),
        }),
      }),
    }),
  }
}

let ws = 0
/** handler 有 60 秒快取：每個 case 用新的帳號編號 */
const nextWs = () => `ws-${++ws}`

beforeEach(() => {
  SOURCES.length = 0
  for (const k of Object.keys(CARDS)) delete CARDS[k]
  for (const k of Object.keys(REGISTRIES)) delete REGISTRIES[k]
  getDb.mockReset()
  getDb.mockImplementation(fakeDb)
  SOURCES.push({ id: 'src1', type: 'gsheet', name: '客服（商品資訊）', gsheetFieldHeaders: HEADERS, createdAt: 1 })
  CARDS.src1 = [{ title: GIARETTI, content: '出貨時間：依原廠公告：\n第一批 10 月底，\n10/7 起第二批 11 月底。\n商品頁面：https://www.myfeel-tw.com/projects/GL-5680' }]
})

describe('送出前換成知識卡上現在寫的', () => {
  it('⭐ 文字裡那一格換成試算表最新的（Giaretti 兩批出貨），前後的字照舊', async () => {
    const [msg] = await hydrateSheetFields([{ type: 'quickReply', text: `{{displayName}}您好，\n${SHIP}\n感謝您的耐心等候。` }], nextWs())
    expect(msg.text).toBe('{{displayName}}您好，\n依原廠公告：\n第一批 10 月底，\n10/7 起第二批 11 月底。\n感謝您的耐心等候。')
  })

  it('按鈕、卡片裡的也換（每一個字串都看）', async () => {
    const [msg] = await hydrateSheetFields([{ type: 'text', text: '看這裡', buttons: [{ type: 'uri', label: '商品頁', uri: PAGE }] }], nextWs())
    expect(msg.buttons[0].uri).toBe('https://www.myfeel-tw.com/projects/GL-5680')
  })

  it('列名稱大小寫、全半形空白不一樣也認得', async () => {
    const loose = sheetFieldToken({ row: 'giaretti  珈樂堤《小滑手》全自動義式咖啡機 GL-5680', field: '出貨時間' })
    const [msg] = await hydrateSheetFields([{ type: 'text', text: loose }], nextWs())
    expect(msg.text).toContain('第二批 11 月底')
  })
})

describe('換不到的時候', () => {
  it('⛔ 那一列被刪了：用存檔當時的內容，不送原字', async () => {
    CARDS.src1 = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [msg] = await hydrateSheetFields([{ type: 'text', text: SHIP, sheetSnapshots: { [SHIP]: '10 月底出貨（存檔當時）' } }], nextWs())
    expect(msg.text).toBe('10 月底出貨（存檔當時）')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('⛔ 連存檔當時的都沒有：留空並留 log——絕不把 {{sheet:…}} 原字送給客人', async () => {
    CARDS.src1 = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [msg] = await hydrateSheetFields([{ type: 'text', text: `出貨：${SHIP}` }], nextWs())
    expect(msg.text).toBe('出貨：')
    expect(JSON.stringify(msg)).not.toContain('{{sheet:')
    warn.mockRestore()
  })

  it('讀不到資料庫：照樣用存檔當時的內容送（不讓整則送不出去）', async () => {
    getDb.mockImplementation(() => { throw new Error('firestore down') })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [msg] = await hydrateSheetFields([{ type: 'text', text: SHIP, sheetSnapshots: { [SHIP]: '存檔當時' } }], nextWs())
    expect(msg.text).toBe('存檔當時')
    err.mockRestore()
    warn.mockRestore()
  })

  it('這份表還沒同步過（不知道有哪幾欄）：當作換不到', async () => {
    SOURCES[0]!.gsheetFieldHeaders = undefined
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [msg] = await hydrateSheetFields([{ type: 'text', text: SHIP, sheetSnapshots: { [SHIP]: '存檔當時' } }], nextWs())
    expect(msg.text).toBe('存檔當時')
    warn.mockRestore()
  })
})

describe('不送給 LINE 的東西', () => {
  it('⛔ sheetSnapshots 拿掉（文字訊息是整包展開送出去的）', async () => {
    const [msg] = await hydrateSheetFields([{ type: 'text', text: SHIP, sheetSnapshots: { [SHIP]: 'x' } }], nextWs())
    expect(msg).not.toHaveProperty('sheetSnapshots')
  })

  it('沒用到的模組：不讀資料庫；殘留的 sheetSnapshots 一樣拿掉', async () => {
    const plain = [{ type: 'text', text: '今天公休' }]
    expect(await hydrateSheetFields(plain, nextWs())).toBe(plain)
    expect(getDb).not.toHaveBeenCalled()
    const [msg] = await hydrateSheetFields([{ type: 'text', text: 'x', sheetSnapshots: {} }], nextWs())
    expect(msg).toEqual({ type: 'text', text: 'x' })
  })
})

describe('存檔時記下當下的內容', () => {
  it('記用到的那幾格；沒用到的訊息原樣', async () => {
    const out = await attachSheetSnapshots([{ type: 'text', text: SHIP }, { type: 'image', originalContentUrl: 'https://x' }], nextWs())
    expect(out[0].sheetSnapshots).toEqual({ [SHIP]: '依原廠公告：\n第一批 10 月底，\n10/7 起第二批 11 月底。' })
    expect(out[1]).toEqual({ type: 'image', originalContentUrl: 'https://x' })
  })

  it('⛔ 讀不到試算表：留著上一次記的（那是唯一的退路）', async () => {
    CARDS.src1 = []
    const out = await attachSheetSnapshots([{ type: 'text', text: SHIP, sheetSnapshots: { [SHIP]: '上次的' } }], nextWs())
    expect(out[0].sheetSnapshots).toEqual({ [SHIP]: '上次的' })
  })
})

describe('編輯頁要的清單', () => {
  it('每份表列出每一列、每一欄切好的內容；還沒同步過的表 headers 是 null', async () => {
    SOURCES.push({ id: 'src2', type: 'gsheet', name: '客服（FAQ）', createdAt: 2 })
    CARDS.src2 = [{ title: '退款多久', content: '7 天' }]
    const { sources } = await loadSheetRows(nextWs())
    expect(sources[0]).toMatchObject({ id: 'src1', name: '客服（商品資訊）', headers: HEADERS })
    expect(sources[0]!.rows[0]!.values['商品頁面']).toBe('https://www.myfeel-tw.com/projects/GL-5680')
    expect(sources[1]).toMatchObject({ id: 'src2', headers: null })
  })

  it('刪掉的表不列', async () => {
    SOURCES[0]!.isDeleted = true
    const { sources } = await loadSheetRows(nextWs())
    expect(sources).toHaveLength(0)
  })
})

describe('`C-432` 試算表上改了名的商品：模組裡用舊名寫的那一格接到現在這一列', () => {
  const KIE_OLD = 'KIESLECT 小耳記 AI NotePods 10S'
  const KIE_NEW = 'KIESLECT 小耳記 AI NotePods 10S Pro'
  const OLD_TOKEN = sheetFieldToken({ row: KIE_OLD, field: '出貨時間' })
  const registry = (aliases: string[], missingSince: number | null = null) => ({
    products: { p1: { id: 'p1', title: KIE_NEW, nameKey: KIE_NEW.toLowerCase(), aliases, pageUrl: null, urlKey: null, inCatalog: true, order: 0, firstSeenAt: 0, missingSince } },
    changes: [],
    catalogColumn: true,
    pageHeader: '商品頁面',
  })

  beforeEach(() => {
    CARDS.src1 = [{ title: KIE_NEW, content: '出貨時間：依原廠公告：商品將於 10 月下旬 依照訂單順序陸續出貨。' }]
  })

  it('⭐ 商品清單記得舊名字：換成現在那一列最新的內容（⛔ 不再停在存檔那天）', async () => {
    REGISTRIES.src1 = registry([KIE_OLD.toLowerCase()])
    const [msg] = await hydrateSheetFields([{ type: 'text', text: OLD_TOKEN, sheetSnapshots: { [OLD_TOKEN]: '存檔那天的' } }], nextWs())
    expect(msg.text).toBe('依原廠公告：商品將於 10 月下旬 依照訂單順序陸續出貨。')
  })

  it('對照組：沒有商品清單（還沒同步過）＝跟以前一樣，用存檔當時的內容', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [msg] = await hydrateSheetFields([{ type: 'text', text: OLD_TOKEN, sheetSnapshots: { [OLD_TOKEN]: '存檔那天的' } }], nextWs())
    expect(msg.text).toBe('存檔那天的')
    warn.mockRestore()
  })

  it('⛔ 舊名字剛好是另一份表上現在的名字：那一列優先，不接過去', async () => {
    REGISTRIES.src1 = registry([KIE_OLD.toLowerCase()])
    SOURCES.push({ id: 'src2', type: 'gsheet', name: '別份表', gsheetFieldHeaders: HEADERS, createdAt: 2 })
    CARDS.src2 = [{ title: KIE_OLD, content: '出貨時間：別份表寫的' }]
    const [msg] = await hydrateSheetFields([{ type: 'text', text: OLD_TOKEN }], nextWs())
    expect(msg.text).toBe('別份表寫的')
  })
})

describe('`C-437` 商品資訊範本：填客人在商品目錄點的那個商品', () => {
  const at = (field: string) => sheetFieldToken({ row: '@', field })
  const COVER = 'https://storage.googleapis.com/b/uploads/ws/sheet-products/g.jpg'
  const product = (over: Record<string, unknown> = {}) => ({
    id: 'pg', title: GIARETTI, nameKey: '', aliases: [], pageUrl: null, urlKey: null, inCatalog: true, order: 0, firstSeenAt: 0, missingSince: null,
    cover: { url: COVER, fromUrlKey: 'x', at: 1 },
    ...over,
  })
  const template = () => ({
    type: 'text',
    imageUrl: at('@image'),
    title: at('@name'),
    text: `出貨時間：${at('出貨時間')}\n${at('額外資訊')}\n有問題直接留言`,
    buttons: [{ type: 'uri', label: '查看商品頁', uri: at('商品頁面') }],
  })

  beforeEach(() => {
    SOURCES[0]!.gsheetFieldHeaders = [...HEADERS, '額外資訊']
    REGISTRIES.src1 = { products: { pg: product() }, changes: [], catalogColumn: true, pageHeader: '商品頁面' }
  })

  it('⭐ 名字、圖照商品清單；出貨時間、商品頁照這份試算表這一列現在寫的；空白的額外資訊整行不顯示', async () => {
    const [msg] = await hydrateSheetFields([template()], nextWs(), { product: 'src1:pg' })
    expect(msg).toEqual({
      type: 'text',
      imageUrl: COVER,
      title: GIARETTI,
      text: '出貨時間：依原廠公告：\n第一批 10 月底，\n10/7 起第二批 11 月底。\n有問題直接留言',
      buttons: [{ type: 'uri', label: '查看商品頁', uri: 'https://www.myfeel-tw.com/projects/GL-5680' }],
    })
  })

  it('自己換過圖：用自己換的那張', async () => {
    REGISTRIES.src1.products.pg = product({ ownImage: { url: 'https://s/own.jpg', at: 2 } })
    const [msg] = await hydrateSheetFields([template()], nextWs(), { product: 'src1:pg' })
    expect(msg.imageUrl).toBe('https://s/own.jpg')
  })

  it('⛔ 沒帶商品（關鍵字、別的按鈕叫出來的）：用到這個商品的行都不顯示、網址按鈕拿掉、不帶圖，留 log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [msg] = await hydrateSheetFields([template()], nextWs())
    expect(msg).toEqual({ type: 'text', text: '有問題直接留言', buttons: [] })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('⛔ 商品代號對不到（別份表、被清掉）：當作沒有，絕不把 {{sheet:…}} 原字送出去', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const ref of ['src9:pg', 'src1:nope', '壞掉的']) {
      const [msg] = await hydrateSheetFields([template()], nextWs(), { product: ref })
      expect(JSON.stringify(msg)).not.toContain('{{sheet:')
      expect(msg.text).toBe('有問題直接留言')
    }
    warn.mockRestore()
  })

  it('表上已經沒有這一列（商品還在清單上）：名字、圖照放，其他格當空白', async () => {
    CARDS.src1 = []
    const [msg] = await hydrateSheetFields([template()], nextWs(), { product: 'src1:pg' })
    expect(msg).toMatchObject({ title: GIARETTI, imageUrl: COVER, text: '有問題直接留言', buttons: [] })
  })

  it('同一則裡也有列名寫死的格子：兩種都換好', async () => {
    const [msg] = await hydrateSheetFields([{ type: 'text', text: `${at('@name')}｜${PAGE}` }], nextWs(), { product: 'src1:pg' })
    expect(msg.text).toBe(`${GIARETTI}｜https://www.myfeel-tw.com/projects/GL-5680`)
  })

  it('存檔時：「這個商品」的格子不記存檔當時的內容（每個商品不一樣，記了也不能用）', async () => {
    const [msg] = await attachSheetSnapshots([{ type: 'text', text: `${at('出貨時間')}\n${SHIP}` }], nextWs())
    expect(Object.keys(msg.sheetSnapshots)).toEqual([SHIP])
  })
})
