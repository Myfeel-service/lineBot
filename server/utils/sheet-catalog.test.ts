/**
 * `C-436`：商品目錄「照試算表排」的伺服器那半。
 * 釘這幾件事：
 *   ① 送出前照商品清單產生卡片；別的訊息原樣；一張卡都沒有的那則不送（LINE 不收空的，整包會被退）。
 *   ② 存模組時：記下「這份試算表有目錄在用」＋標籤開頭，替勾進目錄的商品建標籤。
 *   ③ 同名標籤已經有了＝直接用那一個，⛔ 不另建一個同名的；建過的不再建。
 *   ④ ⛔ 沒有目錄在用的試算表不建標籤；表上找不到的、沒勾的不建。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) } }))

/** 多個集合的假 Firestore：doc get/set/update、transaction、tags 的 where(workspaceId).where(name) */
const store: Record<string, Record<string, any>> = {}
function col(name: string) {
  store[name] ??= {}
  const docs = store[name]!
  const ref = (id: string): any => ({
    id,
    get: async () => ({ id, exists: id in docs, get: (k: string) => docs[id]?.[k], data: () => docs[id] }),
    set: async (v: any) => { docs[id] = { ...v } },
    update: async (v: any) => { docs[id] = { ...docs[id], ...v } },
  })
  const query = (filters: Array<[string, unknown]>): any => ({
    where: (f: string, _op: string, v: unknown) => query([...filters, [f, v]]),
    limit: () => query(filters),
    get: async () => {
      const hit = Object.entries(docs).filter(([, d]) => filters.every(([f, v]) => d[f] === v))
      return { empty: hit.length === 0, docs: hit.map(([id]) => ({ id, ref: ref(id), data: () => docs[id] })) }
    },
  })
  return { doc: ref, where: (f: string, op: string, v: unknown) => query([]).where(f, op, v) }
}
const db: any = {
  collection: col,
  runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
    get: (r: any) => r.get(),
    set: (r: any, v: any) => { void r.set(v) },
    update: (r: any, v: any) => { void r.update(v) },
  }),
}
vi.mock('./firebase', () => ({ getDb: () => db }))

const { configureSheetCatalogs, ensureSheetProductTags, hydrateSheetCatalogs, clearSheetCatalogCache } = await import('./sheet-catalog')
const { syncSheetProducts } = await import('./sheet-products')

const HEADERS = ['商品頁面']
const card = (title: string, slug: string, checked: boolean) => ({
  title,
  content: `商品頁面：https://www.myfeel-tw.com/projects/${slug}`,
  tags: [],
  controls: { 放進LINE目錄: checked ? 'TRUE' : 'FALSE' },
})
const sheetMsg = (extra: Record<string, unknown> = {}) => ({
  type: 'flexImageCarousel',
  enableImage: true,
  altText: '商品目錄',
  columns: [],
  sheetSource: { sourceId: 'src1', tapModuleId: 'tpl-1', ...extra },
})
const products = () => Object.values(store.sheetProductRegistries!.src1.products as Record<string, any>)
const product = (title: string) => products().find(p => p.title === title)!

async function seed(cards = [card('Giaretti', 'GL-5680', true), card('BOYA mini2', 'boyamini2', true), card('Poketomo', 'poketomo', false)]) {
  await syncSheetProducts(db, 'ws1', 'src1', { cards, fieldHeaders: HEADERS, controlHeaders: ['放進LINE目錄'] })
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]
  clearSheetCatalogCache()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('① 送出前產生卡片', () => {
  it('⭐ 有圖、勾了的變成卡片（帶商品）；別的訊息原樣；我們的 sheetSource 不送給 LINE', async () => {
    await seed()
    const g = product('Giaretti')
    store.sheetProductRegistries!.src1.products[g.id].cover = { url: 'https://s/g.jpg', fromUrlKey: 'x', at: 1 }
    const out = await hydrateSheetCatalogs([{ type: 'text', text: '請選商品' }, sheetMsg()], 'ws1')
    expect(out[0]).toEqual({ type: 'text', text: '請選商品' })
    expect(out[1].sheetSource).toBeUndefined()
    expect(out[1].columns).toHaveLength(1)
    expect(out[1].columns[0]).toMatchObject({ imageUrl: 'https://s/g.jpg', action: { type: 'module', moduleId: 'tpl-1', product: `src1:${g.id}` } })
  })

  it('⛔ 一張卡都沒有（勾了的都還沒有圖）：那一則不送、留 log；別的照送', async () => {
    await seed()
    const out = await hydrateSheetCatalogs([sheetMsg(), { type: 'text', text: '或打字問我' }], 'ws1')
    expect(out).toEqual([{ type: 'text', text: '或打字問我' }])
    expect(console.warn).toHaveBeenCalled()
  })

  it('不是別的帳號的商品清單（⛔ 讀不到別人的）', async () => {
    await seed()
    store.sheetProductRegistries!.src1.products[product('Giaretti').id].cover = { url: 'https://s/g.jpg', fromUrlKey: 'x', at: 1 }
    expect(await hydrateSheetCatalogs([sheetMsg()], 'ws-other')).toEqual([])
  })

  it('沒有照試算表排的訊息：原樣回、一筆都不讀', async () => {
    const msgs = [{ type: 'text', text: 'hi' }]
    expect(await hydrateSheetCatalogs(msgs, 'ws1')).toBe(msgs)
  })
})

describe('② ③ ④ 存模組時建標籤', () => {
  it('⭐ 存模組：記下標籤開頭、替勾進目錄的商品建標籤（沒勾的不建）', async () => {
    await seed()
    await configureSheetCatalogs(db, 'ws1', [sheetMsg({ tagPrefix: '客服 - ' })])
    expect(store.sheetProductRegistries!.src1.catalogTagPrefix).toBe('客服 - ')
    const tags = Object.values(store.tags ?? {})
    expect(tags.map((t: any) => t.name).sort()).toEqual(['客服 - BOYA mini2', '客服 - Giaretti'])
    expect(tags.every((t: any) => t.workspaceId === 'ws1' && /^sheet_product_[0-9a-f]{10}$/.test(t.code) && t.createdBy === 'system')).toBe(true)
    expect(product('Giaretti').tagId).toBeTruthy()
    expect(product('Poketomo').tagId).toBeUndefined()
  })

  it('③ 同名的標籤已經有了（例：MYFEEL 自己建過的）＝直接用那一個；再存一次不重建', async () => {
    await seed()
    store.tags = { 'mine-1': { workspaceId: 'ws1', name: '客服 - Giaretti', code: 'mine' } }
    await configureSheetCatalogs(db, 'ws1', [sheetMsg({ tagPrefix: '客服 - ' })])
    expect(product('Giaretti').tagId).toBe('mine-1')
    const count = Object.keys(store.tags!).length
    await configureSheetCatalogs(db, 'ws1', [sheetMsg({ tagPrefix: '客服 - ' })])
    expect(Object.keys(store.tags!).length).toBe(count)
  })

  it('③ 別的帳號的同名標籤不算', async () => {
    await seed()
    store.tags = { other: { workspaceId: 'ws-other', name: 'Giaretti' } }
    await configureSheetCatalogs(db, 'ws1', [sheetMsg()])
    expect(product('Giaretti').tagId).not.toBe('other')
  })

  it('④ ⛔ 沒有目錄在用的試算表：不建標籤', async () => {
    await seed()
    expect(await ensureSheetProductTags(db, 'ws1', 'src1')).toBe(0)
    expect(store.tags).toBeUndefined()
  })

  it('沒設開頭＝標籤就叫商品名；之後同步新勾進目錄的也會建（每小時同步呼叫同一支）', async () => {
    await seed()
    await configureSheetCatalogs(db, 'ws1', [sheetMsg()])
    expect(store.sheetProductRegistries!.src1.catalogTagPrefix).toBe('')
    expect(Object.values(store.tags!).map((t: any) => t.name)).toContain('Giaretti')
    await seed([card('Giaretti', 'GL-5680', true), card('BOYA mini2', 'boyamini2', true), card('Poketomo', 'poketomo', true)])
    // ⛔ 同步整份覆寫商品清單時，標籤開頭要帶著走
    expect(store.sheetProductRegistries!.src1.catalogTagPrefix).toBe('')
    expect(await ensureSheetProductTags(db, 'ws1', 'src1')).toBe(1)
    expect(product('Poketomo').tagId).toBeTruthy()
  })
})
