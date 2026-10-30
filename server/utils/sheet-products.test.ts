/**
 * `C-434`：同步讀到的卡片 → 商品清單（存在 sheetProductRegistries，doc id＝來源 id）。
 * 釘四件事：
 *   ① MYFEEL 這種「商品頁面」格子是一句話的，認得出網址；勾選欄照「放進LINE目錄」。
 *   ② 第一次寫、什麼都沒變不寫（每小時同步一次，不要每小時寫一筆）。
 *   ③ ⛔ 不是這個帳號的 doc 不讀不寫。
 *   ④ 失敗不丟錯（同步已經把知識卡更新好了）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }) },
}))

import { sheetProductInputFromCards, syncSheetProducts } from './sheet-products'

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

function fakeDb(existing?: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = []
  let doc = existing
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: !!doc,
          get: (k: string) => doc?.[k],
          data: () => doc,
        }),
        set: async (v: Record<string, unknown>) => { writes.push({ __col: name, __id: id, ...v }); doc = v },
      }),
    }),
  } as any
  return { db, writes }
}

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
  const sheet = { cards: [card('Giaretti', 'GL-5680', 'TRUE')], fieldHeaders: HEADERS, controlHeaders: ['放進LINE目錄'] }

  it('② 第一次：寫一份（帶帳號、來源），不記「新增」', async () => {
    const { db, writes } = fakeDb()
    const changes = await syncSheetProducts(db, 'ws1', 'src1', sheet)
    expect(changes).toEqual([])
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ __col: 'sheetProductRegistries', __id: 'src1', workspaceId: 'ws1', sourceId: 'src1', catalogColumn: true, pageHeader: '商品頁面', changes: [] })
    const products = Object.values(writes[0]!.products as Record<string, any>)
    expect(products).toHaveLength(1)
    expect(products[0]).toMatchObject({ title: 'Giaretti', inCatalog: true })
    expect(products[0].id).toMatch(/^[0-9a-f]{10}$/)
  })

  it('② 再同步一次同樣的表：不寫', async () => {
    const { db, writes } = fakeDb()
    await syncSheetProducts(db, 'ws1', 'src1', sheet)
    await syncSheetProducts(db, 'ws1', 'src1', sheet)
    expect(writes).toHaveLength(1)
  })

  it('② 取消勾選：寫、並回傳那一筆變動', async () => {
    const { db, writes } = fakeDb()
    await syncSheetProducts(db, 'ws1', 'src1', sheet)
    const changes = await syncSheetProducts(db, 'ws1', 'src1', { ...sheet, cards: [card('Giaretti', 'GL-5680', 'FALSE')] })
    expect(changes?.map(c => c.kind)).toEqual(['catalogOff'])
    expect(writes).toHaveLength(2)
  })

  it('③ ⛔ doc 是別的帳號的：不寫', async () => {
    const { db, writes } = fakeDb({ workspaceId: 'other', products: {}, changes: [] })
    expect(await syncSheetProducts(db, 'ws1', 'src1', sheet)).toBeNull()
    expect(writes).toHaveLength(0)
  })

  it('④ 寫失敗：回 null、不丟錯', async () => {
    const db = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('boom') } }) }) } as any
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(syncSheetProducts(db, 'ws1', 'src1', sheet)).resolves.toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
