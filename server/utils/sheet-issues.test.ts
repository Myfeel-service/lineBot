import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `C-438`：試算表商品要處理的事（提醒中心五顆＋模組頁那一塊同一支算）。
 * 釘這幾件事：
 *   ① 只看啟用中的商品目錄照的那幾份表；⛔ 沒有目錄在用的表（FAQ 那種）不讀、不報
 *   ② 模組帶出的那一欄、那一列找不到要報；範本的「這個商品」商品名／商品圖永遠在；⛔ 不知道的不報（有表還沒同步過＝不判斷那一列不見）
 *   ③ 讀多少：模組掃描沒換就用快取；沒有模組帶出試算表的格子＝不讀試算表的卡
 */

const scan = { current: { refs: [], modules: [], sheetModules: [] } as any }
const { scanModuleGraph } = vi.hoisted(() => ({ scanModuleGraph: vi.fn(async () => scan.current) }))
vi.mock('./broken-module-refs', () => ({ scanModuleGraph }))
const REGS: Record<string, any> = {}
const { loadSheetProductRegistry } = vi.hoisted(() => ({ loadSheetProductRegistry: vi.fn(async (_db: unknown, _ws: string, id: string) => REGS[id] ?? null) }))
vi.mock('./sheet-products', () => ({ loadSheetProductRegistry }))
const rowsResult = { current: { rows: new Map(), sources: [] } as any }
const { loadSheetRows } = vi.hoisted(() => ({ loadSheetRows: vi.fn(async () => rowsResult.current) }))
vi.mock('./sheet-field-hydrate', () => ({ loadSheetRows }))

const { findSheetIssues, invalidateSheetIssuesCache, sheetFieldIssues, sheetFieldIssueText, sheetProductNames } = await import('./sheet-issues')

const db = {} as any
const product = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, title, nameKey: title, aliases: [], pageUrl: `https://a.com/${id}`, urlKey: `a.com/${id}`, inCatalog: true, order: 0, firstSeenAt: 0, missingSince: null,
  cover: { url: `https://s/${id}.jpg`, fromUrlKey: `a.com/${id}`, at: 1 },
  ...over,
})
const reg = (...ps: any[]) => ({ products: Object.fromEntries(ps.map((p, i) => [p.id, { ...p, order: i }])), changes: [], catalogColumn: true, pageHeader: '商品頁面' })
const mod = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `模組${id}`, isActive: true, catalogSourceIds: [], fieldRefs: [], ...over })
const src = (id: string, headers: string[] | null) => ({ id, name: id, headers, rows: [] })
const row = (title: string, headers: string[]) => [title.toLowerCase(), { sourceId: 'src1', sourceName: 'src1', title, content: '', headers }] as const

let n = 0
const ws = () => `ws-${++n}`

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(REGS)) delete REGS[k]
  rowsResult.current = { rows: new Map(), sources: [] }
})

describe('① 商品目錄', () => {
  it('⭐ 啟用中的目錄：放不下、少了一列各自列出；同一份表只讀一次', async () => {
    const products = Array.from({ length: 11 }, (_, i) => product(`p${i}`, `商品${i}`))
    REGS.src1 = reg(...products, product('gone', '不見了', { missingSince: 5 }))
    scan.current = { refs: [], modules: [], sheetModules: [mod('cat1', { catalogSourceIds: ['src1'] }), mod('cat2', { catalogSourceIds: ['src1'] })] }
    const r = await findSheetIssues(db, ws())
    expect(r.catalogs).toHaveLength(2)
    expect(r.catalogs[0]).toMatchObject({ flowId: 'cat1', flowName: '模組cat1', sourceId: 'src1', overflow: ['商品10'], missing: ['不見了'], renameUnsure: [], noImage: [] })
    expect(loadSheetProductRegistry).toHaveBeenCalledTimes(1)
    expect(loadSheetRows).not.toHaveBeenCalled() // 沒有模組帶出試算表的格子
  })

  it('⛔ 停用的目錄不算；沒有目錄在用的表（FAQ）連讀都不讀', async () => {
    REGS.faq = reg(product('q', '退款多久', { missingSince: 5 }))
    scan.current = { refs: [], modules: [], sheetModules: [mod('cat1', { isActive: false, catalogSourceIds: ['faq'] })] }
    const r = await findSheetIssues(db, ws())
    expect(r).toEqual({ catalogs: [], fields: [] })
    expect(loadSheetProductRegistry).not.toHaveBeenCalled()
  })

  it('還沒同步出商品清單的表：列出目錄（知識庫那一行連結要用），沒有要處理的', async () => {
    scan.current = { refs: [], modules: [], sheetModules: [mod('cat1', { catalogSourceIds: ['src1'] })] }
    const r = await findSheetIssues(db, ws())
    expect(r.catalogs).toEqual([{ flowId: 'cat1', flowName: '模組cat1', sourceId: 'src1', overflow: [], noImage: [], missing: [], renameUnsure: [] }])
  })
})

describe('② 模組用到的那一欄、那一列', () => {
  const H = ['出貨時間', '商品頁面']
  const at = (field: string) => ({ row: '@', field })
  const fixed = (r: string, field: string) => ({ row: r, field })

  it('⭐ 欄名改了、那一列不見了、範本用到不存在的欄：都報；在的、商品名商品圖不報', () => {
    const rows = new Map([row('Giaretti', H)])
    const mods = [mod('m1', { fieldRefs: [fixed('Giaretti', '出貨時間'), fixed('Giaretti', '到貨日'), fixed('YiMi', '出貨時間')] }), mod('tpl', { fieldRefs: [at('@name'), at('@image'), at('出貨時間'), at('額外資訊')] })]
    expect(sheetFieldIssues(mods as any, rows as any, [src('src1', H)] as any)).toEqual([
      { flowId: 'm1', flowName: '模組m1', field: '到貨日', row: 'Giaretti', kind: 'field' },
      { flowId: 'm1', flowName: '模組m1', field: '出貨時間', row: 'YiMi', kind: 'row' },
      { flowId: 'tpl', flowName: '模組tpl', field: '額外資訊', row: null, kind: 'field' },
    ])
  })

  it('⛔ 不知道的不報：有表還沒同步過＝不判斷「那一列不見了」（它的列根本還沒讀進來）；一份有欄名的都沒有＝什麼都不判斷', () => {
    const mods = [mod('m1', { fieldRefs: [fixed('YiMi', '出貨時間'), at('額外資訊')] })]
    expect(sheetFieldIssues(mods as any, new Map() as any, [src('src1', H), src('src2', null)] as any)).toEqual([
      { flowId: 'm1', flowName: '模組m1', field: '額外資訊', row: null, kind: 'field' },
    ])
    expect(sheetFieldIssues(mods as any, new Map() as any, [src('src2', null)] as any)).toEqual([])
  })

  it('提醒那一句：範本講「那一行不會顯示」，一般模組講「停在上次的內容」', () => {
    expect(sheetFieldIssueText({ flowId: 't', flowName: '商品資訊範本', field: '額外資訊', row: null, kind: 'field' })).toBe('範本「商品資訊範本」用到的「額外資訊」這一欄找不到了，那一行不會顯示')
    expect(sheetFieldIssueText({ flowId: 'm', flowName: '出貨進度', field: '出貨時間', row: 'YiMi', kind: 'row' })).toBe('「出貨進度」用到的「YiMi」這一列找不到了，客人收到的停在上次的內容')
    expect(sheetFieldIssueText({ flowId: 'm', flowName: '出貨進度', field: '到貨日', row: 'G', kind: 'field' })).toBe('「出貨進度」用到的「到貨日」這一欄找不到了，客人收到的停在上次的內容')
    expect(sheetProductNames(['A', 'B', 'C', 'D'])).toBe('「A」、「B」、「C」等 4 個')
  })

  it('有模組帶出格子才讀試算表的卡；停用的模組不算', async () => {
    rowsResult.current = { rows: new Map([row('Giaretti', H)]), sources: [src('src1', H)] }
    scan.current = { refs: [], modules: [], sheetModules: [mod('m1', { isActive: false, fieldRefs: [fixed('Giaretti', '到貨日')] })] }
    expect((await findSheetIssues(db, ws())).fields).toEqual([])
    expect(loadSheetRows).not.toHaveBeenCalled()
    scan.current = { refs: [], modules: [], sheetModules: [mod('m1', { fieldRefs: [fixed('Giaretti', '到貨日')] })] }
    expect((await findSheetIssues(db, ws())).fields).toHaveLength(1)
  })
})

describe('③ 快取', () => {
  it('模組掃描沒換＝用上一次的；掃描換了（模組存檔清掉快取）或按了「是改名／不賣了」＝重算', async () => {
    const w = ws()
    REGS.src1 = reg(product('a', 'A'))
    scan.current = { refs: [], modules: [], sheetModules: [mod('cat1', { catalogSourceIds: ['src1'] })] }
    await findSheetIssues(db, w)
    await findSheetIssues(db, w)
    expect(loadSheetProductRegistry).toHaveBeenCalledTimes(1)
    scan.current = { ...scan.current } // 模組存檔 → 掃描重來一份
    await findSheetIssues(db, w)
    expect(loadSheetProductRegistry).toHaveBeenCalledTimes(2)
    invalidateSheetIssuesCache(w)
    await findSheetIssues(db, w)
    expect(loadSheetProductRegistry).toHaveBeenCalledTimes(3)
  })
})
