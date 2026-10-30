/**
 * `C-434`／`C-435`：同步讀到的卡片 → 商品清單（存在 sheetProductRegistries，doc id＝來源 id），以及抓封面圖的排程。
 * 釘這幾件事：
 *   ① MYFEEL 這種「商品頁面」格子是一句話的，認得出網址；勾選欄照「放進LINE目錄」。
 *   ② 第一次寫、什麼都沒變不寫（每小時同步一次，不要每小時寫一筆）；寫的時候標好「還有封面圖要抓」。
 *   ③ ⛔ 不是這個帳號的 doc 不讀不寫。
 *   ④ 失敗不丟錯（同步已經把知識卡更新好了）。
 *   ⑤ 排程：一輪最多 3 個、抓到就寫回、抓不到記原因（⛔ 不默默放棄）、存 Storage 失敗不算次數；沒事要做＝一個空查詢。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
}))
const { fetchProductCover, storeProductCover } = vi.hoisted(() => ({ fetchProductCover: vi.fn(), storeProductCover: vi.fn() }))
vi.mock('./product-cover-image', () => ({ fetchProductCover, storeProductCover }))

import {
  fillSheetProductCovers,
  revertSheetProductImage,
  setSheetProductOwnImage,
  sheetProductInputFromCards,
  syncSheetProducts,
} from './sheet-products'

const HEADERS = ['出貨時間', '商品頁面', '額外資訊1', '常見問答頁']
const card = (title: string, slug: string | null, checked?: string) => ({
  title,
  content: [
    '出貨時間：依原廠公告：商品將於 10 月底 依照訂單順序陸續出貨…',
    ...(slug ? [`商品頁面：以下提供商品頁面連結供您參考： https://www.myfeel-tw.com/projects/${slug}`] : []),
  ].join('\n'),
  tags: [],
  ...(checked !== undefined ? { controls: { 放進LINE目錄: checked } } : {}),
})

/** 一個 doc 的假 Firestore：get／set／update（淺合併）、transaction、where('needsCover','==',true) */
function fakeDb(existing?: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = []
  const state: { doc: Record<string, unknown> | undefined } = { doc: existing }
  const snapOf = (id: string) => ({
    id,
    exists: !!state.doc,
    empty: false,
    get: (k: string) => state.doc?.[k],
    data: () => state.doc,
  })
  const refOf = (name: string, id: string) => {
    const ref: any = {
      id,
      get: async () => snapOf(id),
      set: async (v: Record<string, unknown>) => { writes.push({ __col: name, __id: id, __op: 'set', ...v }); state.doc = { ...v } },
      update: async (v: Record<string, unknown>) => { writes.push({ __col: name, __id: id, __op: 'update', ...v }); state.doc = { ...state.doc, ...v } },
    }
    return ref
  }
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => refOf(name, id),
      where: (field: string, _op: string, value: unknown) => ({
        limit: () => ({
          get: async () => {
            const hit = state.doc && state.doc[field] === value
            const docs = hit ? [{ ...snapOf(String(state.doc!.sourceId)), ref: refOf(name, String(state.doc!.sourceId)) }] : []
            return { empty: docs.length === 0, docs }
          },
        }),
      }),
    }),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
      get: (ref: any) => ref.get(),
      set: (ref: any, v: any) => { void ref.set(v) },
      update: (ref: any, v: any) => { void ref.update(v) },
    }),
  } as any
  return { db, writes, state }
}

const sheet = (cards = [card('Giaretti', 'GL-5680', 'TRUE')]) => ({ cards, fieldHeaders: HEADERS, controlHeaders: ['放進LINE目錄'] })

describe('sheetProductInputFromCards', () => {
  it('① 商品頁取「商品頁面」那格裡的網址；勾選照「放進LINE目錄」；沒這欄＝catalogColumn false', () => {
    const input = sheetProductInputFromCards(
      [card('Giaretti', 'GL-5680', 'TRUE'), card('Poketomo', 'poketomo', 'FALSE'), card('電淨艙', null)],
      HEADERS,
      ['放進LINE目錄'],
    )
    expect(input.pageHeader).toBe('商品頁面')
    expect(input.catalogColumn).toBe(true)
    expect(input.rows).toEqual([
      { title: 'Giaretti', pageUrl: 'https://www.myfeel-tw.com/projects/GL-5680', inCatalog: true },
      { title: 'Poketomo', pageUrl: 'https://www.myfeel-tw.com/projects/poketomo', inCatalog: false },
      { title: '電淨艙', pageUrl: null, inCatalog: false },
    ])
    expect(sheetProductInputFromCards([card('A', 'a')], HEADERS, []).catalogColumn).toBe(false)
  })
})

describe('syncSheetProducts', () => {
  it('② 第一次：寫一份（帶帳號、來源），不記「新增」，標好還有封面圖要抓', async () => {
    const { db, writes } = fakeDb()
    const changes = await syncSheetProducts(db, 'ws1', 'src1', sheet())
    expect(changes).toEqual([])
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ __col: 'sheetProductRegistries', __id: 'src1', workspaceId: 'ws1', sourceId: 'src1', catalogColumn: true, pageHeader: '商品頁面', changes: [], needsCover: true })
    const products = Object.values(writes[0]!.products as Record<string, any>)
    expect(products).toHaveLength(1)
    expect(products[0]).toMatchObject({ title: 'Giaretti', inCatalog: true })
    expect(products[0].id).toMatch(/^[0-9a-f]{10}$/)
  })

  it('② 再同步一次同樣的表：不寫', async () => {
    const { db, writes } = fakeDb()
    await syncSheetProducts(db, 'ws1', 'src1', sheet())
    await syncSheetProducts(db, 'ws1', 'src1', sheet())
    expect(writes).toHaveLength(1)
  })

  it('② 取消勾選：寫、並回傳那一筆變動', async () => {
    const { db, writes } = fakeDb()
    await syncSheetProducts(db, 'ws1', 'src1', sheet())
    const changes = await syncSheetProducts(db, 'ws1', 'src1', sheet([card('Giaretti', 'GL-5680', 'FALSE')]))
    expect(changes?.map(c => c.kind)).toEqual(['catalogOff'])
    expect(writes).toHaveLength(2)
  })

  it('`C-445`：同步讀到 150 列上限（stats.truncatedByCap）那一輪，沒讀到的商品⛔ 不記「少了」', async () => {
    const { db, writes } = fakeDb()
    await syncSheetProducts(db, 'ws1', 'src1', sheet([card('Giaretti', 'GL-5680', 'TRUE'), card('BOYA', 'boya', 'TRUE')]))
    const changes = await syncSheetProducts(db, 'ws1', 'src1', { ...sheet([card('Giaretti', 'GL-5680', 'TRUE')]), stats: { truncatedByCap: true } })
    expect(changes).toEqual([])
    expect(writes).toHaveLength(1)
    // 對照組：沒截斷就是真的少了
    const real = await syncSheetProducts(db, 'ws1', 'src1', sheet([card('Giaretti', 'GL-5680', 'TRUE')]))
    expect(real?.map(c => c.kind)).toEqual(['removed'])
  })

  it('③ ⛔ doc 是別的帳號的：不寫', async () => {
    const { db, writes } = fakeDb({ workspaceId: 'other', products: {}, changes: [] })
    expect(await syncSheetProducts(db, 'ws1', 'src1', sheet())).toBeNull()
    expect(writes).toHaveLength(0)
  })

  it('④ 讀寫失敗：回 null、不丟錯', async () => {
    const db = { collection: () => ({ doc: () => ({}) }), runTransaction: async () => { throw new Error('boom') } } as any
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(syncSheetProducts(db, 'ws1', 'src1', sheet())).resolves.toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('⑤ fillSheetProductCovers', () => {
  const pid = (state: { doc?: Record<string, any> }, title: string) =>
    Object.values(state.doc!.products as Record<string, any>).find(p => p.title === title)!.id as string
  const productIn = (state: { doc?: Record<string, any> }, title: string) =>
    (state.doc!.products as Record<string, any>)[pid(state, title)]

  beforeEach(() => {
    fetchProductCover.mockReset()
    storeProductCover.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('⭐ 抓到：存進 Storage、寫回封面圖、放下旗子', async () => {
    const { db, state } = fakeDb()
    await syncSheetProducts(db, 'ws1', 'src1', sheet())
    fetchProductCover.mockResolvedValue({ ok: true, jpeg: Buffer.from('jpg'), imageUrl: 'https://cdn/x.gif', width: 1200, height: 675 })
    storeProductCover.mockResolvedValue('https://storage.googleapis.com/bkt/uploads/ws1/sheet-products/src1-p-1.jpg')
    const r = await fillSheetProductCovers(db)
    expect(r).toEqual({ tried: 1, fetched: 1, failed: 0 })
    expect(fetchProductCover).toHaveBeenCalledWith('https://www.myfeel-tw.com/projects/GL-5680')
    const p = productIn(state, 'Giaretti')
    expect(p.cover).toMatchObject({ url: 'https://storage.googleapis.com/bkt/uploads/ws1/sheet-products/src1-p-1.jpg', fromUrlKey: 'myfeel-tw.com/projects/gl-5680' })
    expect(state.doc!.needsCover).toBe(false)
  })

  it('一輪最多 3 個；剩下的旗子還在，下一輪接著抓', async () => {
    const { db, state } = fakeDb()
    await syncSheetProducts(db, 'ws1', 'src1', sheet(['a', 'b', 'c', 'd', 'e'].map(s => card(s.toUpperCase(), s))))
    fetchProductCover.mockResolvedValue({ ok: true, jpeg: Buffer.from('j'), imageUrl: 'u', width: 1, height: 1 })
    storeProductCover.mockImplementation(async (_w: string, _s: string, id: string) => `https://s/${id}.jpg`)
    expect(await fillSheetProductCovers(db)).toEqual({ tried: 3, fetched: 3, failed: 0 })
    expect(state.doc!.needsCover).toBe(true)
    expect(await fillSheetProductCovers(db)).toEqual({ tried: 2, fetched: 2, failed: 0 })
    expect(state.doc!.needsCover).toBe(false)
  })

  it('⛔ 抓不到：照原因記下來（給提醒用），找不到封面圖的不再抓', async () => {
    const { db, state } = fakeDb()
    await syncSheetProducts(db, 'ws1', 'src1', sheet())
    fetchProductCover.mockResolvedValue({ ok: false, reason: 'noCover', detail: '商品頁上找不到封面圖' })
    expect(await fillSheetProductCovers(db)).toEqual({ tried: 1, fetched: 0, failed: 1 })
    expect(productIn(state, 'Giaretti').coverError).toMatchObject({ reason: 'noCover', attempts: 1 })
    expect(state.doc!.needsCover).toBe(false)
  })

  it('存進 Storage 失敗（我們這邊的問題）：不記失敗次數，下一輪照樣重試', async () => {
    const { db, state } = fakeDb()
    await syncSheetProducts(db, 'ws1', 'src1', sheet())
    fetchProductCover.mockResolvedValue({ ok: true, jpeg: Buffer.from('j'), imageUrl: 'u', width: 1, height: 1 })
    storeProductCover.mockRejectedValue(new Error('storage down'))
    expect(await fillSheetProductCovers(db)).toEqual({ tried: 1, fetched: 0, failed: 1 })
    expect(productIn(state, 'Giaretti').coverError).toBeUndefined()
    expect(state.doc!.needsCover).toBe(true)
  })

  it('沒有要抓的：一個空查詢，不載圖片工具、不抓', async () => {
    const { db } = fakeDb()
    expect(await fillSheetProductCovers(db)).toEqual({ tried: 0, fetched: 0, failed: 0 })
    expect(fetchProductCover).not.toHaveBeenCalled()
  })
})

describe('換圖／改回（`C-435` 資料；按鈕在 `C-436`）', () => {
  it('換圖：用自己的；改回：拿掉自己的。⛔ 別的帳號的不動', async () => {
    const { db, state } = fakeDb()
    await syncSheetProducts(db, 'ws1', 'src1', sheet())
    const id = Object.keys(state.doc!.products as object)[0]!
    expect(await setSheetProductOwnImage(db, 'other', 'src1', id, 'https://s/own.jpg')).toBeNull()
    await setSheetProductOwnImage(db, 'ws1', 'src1', id, 'https://s/own.jpg')
    expect((state.doc!.products as any)[id].ownImage.url).toBe('https://s/own.jpg')
    await revertSheetProductImage(db, 'ws1', 'src1', id)
    expect((state.doc!.products as any)[id].ownImage).toBeUndefined()
  })
})
