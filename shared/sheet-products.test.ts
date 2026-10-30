import { describe, expect, it } from 'vitest'
import {
  applyCoverResult,
  confirmSheetProductRename,
  dismissSheetProductRename,
  findProductPageHeader,
  firstHttpUrl,
  isSheetControlHeader,
  needsCoverFetch,
  parseSheetCheckbox,
  productImage,
  productsNeedingCover,
  productUrlKey,
  reconcileSheetProducts,
  registryNeedsCover,
  revertProductImage,
  setOwnProductImage,
  sheetProductAliasMap,
  type SheetProductInput,
  type SheetProductRegistry,
} from './sheet-products'

/**
 * `C-434`：試算表上的「商品」——用商品頁網址認，改名不會斷（`C-432`）。
 * 這一組釘四個承諾：
 *   ① 名字變、網址一樣＝同一個商品，自動接上，舊名字留著讓模組的「試算表的一格」照樣找得到。
 *   ② 名字和網址一起變＝認不出來，⛔ 不猜：舊的記「少了」並問「是改名嗎？」，店家確認後接回原本那一個 id。
 *   ③ 第一次建不記「新增」（那不是店家這次做的事）；什麼都沒變就不用寫回去。
 *   ④ 認不得的勾選寫法一律當沒勾。
 */

const URL = (slug: string) => `以下提供商品頁面連結供您參考： https://www.myfeel-tw.com/projects/${slug}`

let n = 0
const ids = () => `p${++n}`

function input(rows: Array<[string, string | null, boolean?]>, extra: Partial<SheetProductInput> = {}): SheetProductInput {
  return {
    rows: rows.map(([title, slug, inCatalog]) => ({ title, pageUrl: slug ? firstHttpUrl(URL(slug)) : null, inCatalog: inCatalog ?? false })),
    catalogColumn: true,
    pageHeader: '商品頁面',
    ...extra,
  }
}

function build(rows: Array<[string, string | null, boolean?]>): SheetProductRegistry {
  n = 0
  return reconcileSheetProducts(null, input(rows), 1000, ids).registry
}

const byTitle = (reg: SheetProductRegistry, title: string) => Object.values(reg.products).find(p => p.title === title)

describe('網址與欄名', () => {
  it('格子是一句話時，取出裡面第一個網址（後面黏著的標點不算）', () => {
    expect(firstHttpUrl(URL('GL-5680'))).toBe('https://www.myfeel-tw.com/projects/GL-5680')
    expect(firstHttpUrl('請看 https://a.com/x。謝謝')).toBe('https://a.com/x')
    expect(firstHttpUrl('（https://a.com/y）')).toBe('https://a.com/y')
    expect(firstHttpUrl('沒有網址')).toBeNull()
  })

  it('網址 key：www、大小寫、結尾斜線、%20 跟空白、查詢字串都不算差別', () => {
    const k = productUrlKey('https://www.myfeel-tw.com/projects/AINotePods%2010S')
    expect(k).toBe('myfeel-tw.com/projects/ainotepods 10s')
    expect(productUrlKey('https://myfeel-tw.com/projects/AINotePods 10S/?utm=1#faq')).toBe(k)
    expect(productUrlKey('不是網址')).toBeNull()
    expect(productUrlKey('ftp://a.com/x')).toBeNull()
  })

  it('商品頁那一欄：認「商品頁」，⛔「常見問答頁」不算', () => {
    expect(findProductPageHeader(['出貨時間', '常見問答頁', '商品頁面', '額外資訊1'])).toBe('商品頁面')
    expect(findProductPageHeader(['出貨時間', '額外資訊1'])).toBeNull()
  })

  it('開關欄：「放進LINE目錄」全半形、空白、大小寫都認', () => {
    expect(isSheetControlHeader('放進LINE目錄')).toBe(true)
    expect(isSheetControlHeader(' 放進 line 目錄 ')).toBe(true)
    expect(isSheetControlHeader('放進ＬＩＮＥ目錄')).toBe(true)
    expect(isSheetControlHeader('常見問答頁')).toBe(false)
  })

  it('勾選：TRUE、打勾、是都算；FALSE、空白、認不得的一律當沒勾', () => {
    for (const v of ['TRUE', 'true', '✓', 'V', '是', '1']) expect(parseSheetCheckbox(v)).toBe(true)
    for (const v of ['FALSE', '', '否', '不要', 'x', undefined]) expect(parseSheetCheckbox(v)).toBe(false)
  })
})

describe('reconcileSheetProducts', () => {
  it('第一次建：每一列一個商品，⛔ 不記「新增」，但要寫回去', () => {
    n = 0
    const r = reconcileSheetProducts(null, input([['Giaretti 小滑手', 'GL-5680', true], ['BOYA mini2', 'boyamini2']]), 1000, ids)
    expect(Object.keys(r.registry.products)).toHaveLength(2)
    expect(r.newChanges).toEqual([])
    expect(r.changed).toBe(true)
    expect(byTitle(r.registry, 'Giaretti 小滑手')).toMatchObject({ inCatalog: true, order: 0, missingSince: null, urlKey: 'myfeel-tw.com/projects/gl-5680' })
  })

  it('什麼都沒變：changed=false（不用每小時寫一次）', () => {
    const reg = build([['Giaretti 小滑手', 'GL-5680', true]])
    const r = reconcileSheetProducts(reg, input([['Giaretti 小滑手', 'GL-5680', true]]), 2000, ids)
    expect(r.changed).toBe(false)
    expect(r.newChanges).toEqual([])
  })

  it('Firestore 讀回來的鍵順序不同也不算變（比對照內容不照字串）', () => {
    const reg = build([['A', 'a', true]])
    const p = Object.values(reg.products)[0]!
    const shuffled: SheetProductRegistry = {
      pageHeader: reg.pageHeader,
      catalogColumn: reg.catalogColumn,
      changes: reg.changes,
      products: { [p.id]: Object.fromEntries(Object.entries(p).reverse()) as typeof p },
    }
    expect(reconcileSheetProducts(shuffled, input([['A', 'a', true]]), 2000, ids).changed).toBe(false)
  })

  it('① 改名、網址一樣：同一個 id 自動接上，記「改名」，舊名字留在 aliases', () => {
    const reg = build([['KIESLECT 小耳記 AI NotePods 10S', 'AINotePods%2010S', true]])
    const id = Object.keys(reg.products)[0]!
    const r = reconcileSheetProducts(reg, input([['KIESLECT 小耳記 AI NotePods 10S Pro', 'AINotePods%2010S', true]]), 2000, ids)
    expect(Object.keys(r.registry.products)).toEqual([id])
    expect(r.registry.products[id]).toMatchObject({ title: 'KIESLECT 小耳記 AI NotePods 10S Pro', aliases: ['kieslect 小耳記 ai notepods 10s'], inCatalog: true })
    expect(r.newChanges).toEqual([{ at: 2000, kind: 'renamed', productId: id, title: 'KIESLECT 小耳記 AI NotePods 10S Pro', prevTitle: 'KIESLECT 小耳記 AI NotePods 10S' }])
    // 模組用舊名寫的「試算表的一格」接得到現在這一列
    expect(sheetProductAliasMap(r.registry).get('kieslect 小耳記 ai notepods 10s')).toBe('kieslect 小耳記 ai notepods 10s pro')
  })

  it('沒有商品頁網址的表：用名字認，名字一樣就是同一個', () => {
    n = 0
    const reg = reconcileSheetProducts(null, input([['W1', null]], { pageHeader: null }), 1000, ids).registry
    const r = reconcileSheetProducts(reg, input([['W1', null, true]], { pageHeader: null }), 2000, ids)
    expect(Object.keys(r.registry.products)).toEqual(Object.keys(reg.products))
    expect(r.newChanges.map(c => c.kind)).toEqual(['catalogOn'])
  })

  it('換了商品頁網址但名字一樣：還是同一個（名字接得上）', () => {
    const reg = build([['Giaretti 小滑手', 'GL-5680', true]])
    const id = Object.keys(reg.products)[0]!
    const r = reconcileSheetProducts(reg, input([['Giaretti 小滑手', 'GL-5680-new', true]]), 2000, ids)
    expect(Object.keys(r.registry.products)).toEqual([id])
    expect(r.registry.products[id]!.urlKey).toBe('myfeel-tw.com/projects/gl-5680-new')
    expect(r.changed).toBe(true)
    expect(r.newChanges).toEqual([])
  })

  it('② 名字和網址一起改：⛔ 不猜。舊的記「找不到、是改名嗎？」，新的另外建；確認後接回舊 id', () => {
    const reg = build([['KIESLECT 10S', 'k10s', true], ['Giaretti', 'GL-5680', true]])
    const oldId = byTitle(reg, 'KIESLECT 10S')!.id
    const r = reconcileSheetProducts(reg, input([['KIESLECT 10S Pro', 'k10s-pro', true], ['Giaretti', 'GL-5680', true]]), 2000, ids)
    const newId = byTitle(r.registry, 'KIESLECT 10S Pro')!.id
    expect(newId).not.toBe(oldId)
    expect(r.registry.products[oldId]).toMatchObject({ missingSince: 2000, renameCandidates: [newId] })
    expect(r.newChanges.map(c => c.kind).sort()).toEqual(['added', 'renameUnsure'])

    const merged = confirmSheetProductRename(r.registry, oldId, newId, 3000)!
    expect(Object.keys(merged.products).sort()).toEqual(Object.keys(reg.products).sort())
    expect(merged.products[oldId]).toMatchObject({ title: 'KIESLECT 10S Pro', missingSince: null, urlKey: 'myfeel-tw.com/projects/k10s-pro', aliases: ['kieslect 10s'] })
    expect(merged.products[oldId]!.renameCandidates).toBeUndefined()
    expect(merged.changes[0]).toMatchObject({ kind: 'renamed', productId: oldId, prevTitle: 'KIESLECT 10S' })

    // 接好之後再同步一次：用新網址認得到舊 id，不會又多一個
    const again = reconcileSheetProducts(merged, input([['KIESLECT 10S Pro', 'k10s-pro', true], ['Giaretti', 'GL-5680', true]]), 4000, ids)
    expect(again.changed).toBe(false)
  })

  it('② 店家說「不賣了」：不再問，那個商品維持找不到', () => {
    const reg = build([['A', 'a'], ['B', 'b']])
    const aId = byTitle(reg, 'A')!.id
    const r = reconcileSheetProducts(reg, input([['C', 'c'], ['B', 'b']]), 2000, ids)
    const dismissed = dismissSheetProductRename(r.registry, aId)!
    expect(dismissed.products[aId]!.renameCandidates).toBeUndefined()
    expect(dismissed.products[aId]!.missingSince).toBe(2000)
    expect(dismissSheetProductRename(dismissed, aId)).toBeNull()
  })

  it('少了一列（這一輪沒有新增）：記「少了」不刪；加回來接上原本的 id，記「回來了」', () => {
    const reg = build([['A', 'a', true], ['B', 'b']])
    const aId = byTitle(reg, 'A')!.id
    const gone = reconcileSheetProducts(reg, input([['B', 'b']]), 2000, ids)
    expect(gone.registry.products[aId]).toMatchObject({ missingSince: 2000 })
    expect(gone.newChanges).toEqual([{ at: 2000, kind: 'removed', productId: aId, title: 'A' }])
    // 下一輪還是不在：不重複記
    expect(reconcileSheetProducts(gone.registry, input([['B', 'b']]), 3000, ids).changed).toBe(false)
    const back = reconcileSheetProducts(gone.registry, input([['A', 'a', true], ['B', 'b']]), 4000, ids)
    expect(back.registry.products[aId]).toMatchObject({ missingSince: null, inCatalog: true })
    expect(back.newChanges.map(c => c.kind)).toEqual(['returned'])
  })

  it('勾、取消勾、換順序：開關記一筆，順序變了要寫回去但不記（不是店家要看的事）', () => {
    const reg = build([['A', 'a', true], ['B', 'b', false]])
    const r = reconcileSheetProducts(reg, input([['B', 'b', true], ['A', 'a', false]]), 2000, ids)
    expect(r.newChanges.map(c => `${c.title}:${c.kind}`).sort()).toEqual(['A:catalogOff', 'B:catalogOn'])
    expect(byTitle(r.registry, 'B')!.order).toBe(0)
    const reorderOnly = reconcileSheetProducts(r.registry, input([['A', 'a', false], ['B', 'b', true]]), 3000, ids)
    expect(reorderOnly.newChanges).toEqual([])
    expect(reorderOnly.changed).toBe(true)
  })

  it('表內同名的列只認第一列（跟同步配卡片同一個規矩）', () => {
    const reg = build([['A', 'a', true], [' a ', 'x', false]])
    expect(Object.values(reg.products)).toHaveLength(1)
  })

  it('「最近的變動」新的在前、最多 30 筆', () => {
    let reg = build([['A', 'a']])
    for (let i = 0; i < 40; i++) reg = reconcileSheetProducts(reg, input([['A', 'a', i % 2 === 0]]), 2000 + i, ids).registry
    expect(reg.changes).toHaveLength(30)
    expect(reg.changes[0]!.at).toBe(2039)
  })

  it('舊名字剛好是另一個現在還在的商品＝那個商品優先，⛔ 不接過去', () => {
    const reg = build([['A', 'a'], ['B', 'b']])
    // A 改名成 A2（網址一樣）
    const r1 = reconcileSheetProducts(reg, input([['A2', 'a'], ['B', 'b']]), 2000, ids).registry
    // 又新增一個叫 A 的新商品（網址不同）
    const r2 = reconcileSheetProducts(r1, input([['A2', 'a'], ['B', 'b'], ['A', 'z']]), 3000, ids).registry
    expect(Object.values(r2.products)).toHaveLength(3)
    expect(sheetProductAliasMap(r2).has('a')).toBe(false)
  })
})

describe('`C-435` 商品圖：封面圖、自己換的、要不要抓', () => {
  const productOf = (reg: SheetProductRegistry, title: string) => byTitle(reg, title)!
  const ok = (url: string) => ({ ok: true as const, url })
  const fail = (reason: 'noCover' | 'pageUnreachable' | 'badImage') => ({ ok: false as const, reason })

  it('有商品頁網址、還沒有封面圖＝要抓；沒有網址、表上找不到的＝不抓', () => {
    const reg = build([['A', 'a'], ['B', null]])
    expect(needsCoverFetch(productOf(reg, 'A'))).toBe(true)
    expect(needsCoverFetch(productOf(reg, 'B'))).toBe(false)
    const gone = reconcileSheetProducts(reg, input([['B', null]]), 2000, ids).registry
    expect(needsCoverFetch(productOf(gone, 'A'))).toBe(false)
  })

  it('抓到了：用這張、不再抓；商品頁網址換了＝舊的先留著用、再抓新的', () => {
    const reg = build([['A', 'a', true]])
    const a = productOf(reg, 'A')
    const got = applyCoverResult(reg, a.id, a.urlKey!, ok('https://s/a.jpg'), 2000)!
    expect(productImage(got.products[a.id]!)).toEqual({ url: 'https://s/a.jpg', source: 'web' })
    expect(registryNeedsCover(got)).toBe(false)
    const moved = reconcileSheetProducts(got, input([['A', 'a2', true]]), 3000, ids).registry
    expect(needsCoverFetch(moved.products[a.id]!)).toBe(true)
    expect(productImage(moved.products[a.id]!)?.url).toBe('https://s/a.jpg')
  })

  it('⛔ 抓的這段時間網址換了：舊網址的結果不寫（下一輪照新網址抓）', () => {
    const reg = build([['A', 'a']])
    const a = productOf(reg, 'A')
    const moved = reconcileSheetProducts(reg, input([['A', 'a2']]), 2000, ids).registry
    expect(applyCoverResult(moved, a.id, a.urlKey!, ok('https://s/old.jpg'), 3000)).toBeNull()
  })

  it('找不到封面圖：不重試；連不上：最多 3 次；網址換了重新算', () => {
    const reg = build([['A', 'a'], ['B', 'b']])
    const a = productOf(reg, 'A')
    const b = productOf(reg, 'B')
    let r = applyCoverResult(reg, a.id, a.urlKey!, fail('noCover'), 2000)!
    expect(needsCoverFetch(r.products[a.id]!)).toBe(false)
    for (let i = 1; i <= 3; i++) {
      expect(needsCoverFetch(r.products[b.id]!)).toBe(true)
      r = applyCoverResult(r, b.id, b.urlKey!, fail('pageUnreachable'), 2000 + i)!
      expect(r.products[b.id]!.coverError).toMatchObject({ reason: 'pageUnreachable', attempts: i })
    }
    expect(needsCoverFetch(r.products[b.id]!)).toBe(false)
    expect(registryNeedsCover(r)).toBe(false)
    const moved = reconcileSheetProducts(r, input([['A', 'a-new'], ['B', 'b']]), 9000, ids).registry
    expect(needsCoverFetch(moved.products[a.id]!)).toBe(true)
  })

  it('先抓還沒有任何圖的、在目錄上的先', () => {
    const reg = build([['A', 'a', false], ['B', 'b', true], ['C', 'c', false]])
    const c = productOf(reg, 'C')
    const withC = setOwnProductImage(reg, c.id, 'https://s/own.jpg', 2000)!
    expect(productsNeedingCover(withC).map(p => p.title)).toEqual(['B', 'A', 'C'])
  })

  it('自己換的圖優先；照樣抓封面圖留著；改回＝馬上用封面圖', () => {
    const reg = build([['A', 'a', true]])
    const a = productOf(reg, 'A')
    let r = setOwnProductImage(reg, a.id, 'https://s/own.jpg', 2000)!
    expect(productImage(r.products[a.id]!)).toEqual({ url: 'https://s/own.jpg', source: 'own' })
    expect(needsCoverFetch(r.products[a.id]!)).toBe(true)
    r = applyCoverResult(r, a.id, a.urlKey!, ok('https://s/cover.jpg'), 3000)!
    expect(productImage(r.products[a.id]!)?.source).toBe('own')
    r = revertProductImage(r, a.id)!
    expect(productImage(r.products[a.id]!)).toEqual({ url: 'https://s/cover.jpg', source: 'web' })
    expect(revertProductImage(r, a.id)).toBeNull()
  })

  it('同步不會把圖弄掉（比對只動名字、網址、勾選、順序）', () => {
    const reg = build([['A', 'a', true]])
    const a = productOf(reg, 'A')
    const r = applyCoverResult(reg, a.id, a.urlKey!, ok('https://s/a.jpg'), 2000)!
    const again = reconcileSheetProducts(r, input([['A 改名', 'a', false]]), 3000, ids).registry
    expect(productImage(again.products[a.id]!)?.url).toBe('https://s/a.jpg')
  })

  it('確認改名：店家換過的圖跟著舊的走；封面圖用新那一列的', () => {
    const reg = build([['K10S', 'k10s', true]])
    const old = productOf(reg, 'K10S')
    let r = setOwnProductImage(reg, old.id, 'https://s/own.jpg', 1500)!
    r = reconcileSheetProducts(r, input([['K10S Pro', 'k10s-pro', true]]), 2000, ids).registry
    const nw = productOf(r, 'K10S Pro')
    r = applyCoverResult(r, nw.id, nw.urlKey!, ok('https://s/pro-cover.jpg'), 2500)!
    const merged = confirmSheetProductRename(r, old.id, nw.id, 3000)!
    expect(merged.products[old.id]!.ownImage?.url).toBe('https://s/own.jpg')
    expect(merged.products[old.id]!.cover?.url).toBe('https://s/pro-cover.jpg')
  })
})
