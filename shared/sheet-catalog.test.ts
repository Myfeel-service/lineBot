import { describe, expect, it } from 'vitest'
import { encodeTriggerModule, parseTriggerModuleData, LINE_POSTBACK_DATA_MAX } from './action-schema'
import { cardMessageError } from './card-message'
import {
  parseSheetProductRef,
  planSheetCatalog,
  readSheetCatalogSource,
  sheetCatalogColumns,
  sheetCatalogError,
  sheetProductRef,
  sheetProductTagName,
} from './sheet-catalog'
import { reconcileSheetProducts, setOwnProductImage, type SheetProductRegistry } from './sheet-products'

/**
 * `C-436`：商品目錄「照試算表排」。
 * 釘五件事：
 *   ① 卡片＝勾了、有圖、還在表上的商品，照試算表順序，最多 10 張；⛔ 沒放上去的（第 11 張以後、沒有圖）講得出是哪幾個。
 *   ② 每張卡點了送範本、帶上「哪一份試算表的哪個商品」、貼這個商品的標籤。
 *   ③ 帶商品的 postback 編得回來、塞得進 LINE 的 300 字；舊的 postback（沒帶商品）解出來跟以前一模一樣。
 *   ④ 存檔檢查：照試算表排的不看卡片（送出時才產生），只看選了哪份表、點了送哪個模組。
 *   ⑤ 自動建的標籤名稱＝開頭＋商品名。
 */

const SRC = '6f1c2d3e-aaaa-bbbb-cccc-1234567890ab'
let n = 0
const ids = () => `p${String(++n).padStart(2, '0')}`

/** rows：[商品名, 勾了嗎, 有圖嗎] */
function registry(rows: Array<[string, boolean, boolean]>): SheetProductRegistry {
  n = 0
  let reg = reconcileSheetProducts(null, {
    rows: rows.map(([title, inCatalog]) => ({ title, pageUrl: `https://a.com/${encodeURIComponent(title)}`, inCatalog })),
    catalogColumn: true,
    pageHeader: '商品頁面',
  }, 1000, ids).registry
  for (const [title, , hasImage] of rows) {
    if (!hasImage) continue
    const p = Object.values(reg.products).find(x => x.title === title)!
    reg = setOwnProductImage(reg, p.id, `https://s/${title}.jpg`, 1000)!
  }
  return reg
}

describe('① 哪些商品上目錄', () => {
  it('勾了、有圖的照試算表順序；沒勾的不放；勾了沒圖的另外列出來', () => {
    const plan = planSheetCatalog(registry([['A', true, true], ['B', false, true], ['C', true, false], ['D', true, true]]))
    expect(plan.cards.map(p => p.title)).toEqual(['A', 'D'])
    expect(plan.noImage.map(p => p.title)).toEqual(['C'])
    expect(plan.overflow).toEqual([])
  })

  it('最多 10 張；第 11 張以後的講得出是哪幾個', () => {
    const rows = Array.from({ length: 12 }, (_, i) => [`商品${i + 1}`, true, true] as [string, boolean, boolean])
    const plan = planSheetCatalog(registry(rows))
    expect(plan.cards).toHaveLength(10)
    expect(plan.overflow.map(p => p.title)).toEqual(['商品11', '商品12'])
  })

  it('表上找不到的（被刪掉）不放', () => {
    let reg = registry([['A', true, true], ['B', true, true]])
    reg = reconcileSheetProducts(reg, { rows: [{ title: 'B', pageUrl: 'https://a.com/B', inCatalog: true }], catalogColumn: true, pageHeader: '商品頁面' }, 2000, ids).registry
    expect(planSheetCatalog(reg).cards.map(p => p.title)).toEqual(['B'])
  })
})

describe('② 每張卡長什麼樣', () => {
  it('整張圖、點了送範本、帶商品、有標籤就貼', () => {
    let reg = registry([['A', true, true], ['B', true, true]])
    const a = Object.values(reg.products).find(p => p.title === 'A')!
    reg = { ...reg, products: { ...reg.products, [a.id]: { ...a, tagId: 'tag-a' } } }
    const cols = sheetCatalogColumns({ sourceId: SRC, tapModuleId: 'tpl-1' }, reg)
    expect(cols).toHaveLength(2)
    expect(cols[0]).toEqual({
      imageUrl: 'https://s/A.jpg',
      title: '',
      text: '',
      action: { type: 'module', moduleId: 'tpl-1', product: `${SRC}:${a.id}`, tagging: { enabled: true, addTagIds: ['tag-a'] } },
      actions: [],
    })
    expect(cols[1].action.tagging).toEqual({ enabled: false, addTagIds: [] })
  })
})

describe('③ postback 帶商品', () => {
  it('編得回來；舊的（沒帶商品）解出來跟以前一模一樣', () => {
    const data = encodeTriggerModule('tpl-1', ['tag-a'], sheetProductRef(SRC, 'a1b2c3d4e5'))
    expect(parseTriggerModuleData(data)).toEqual({ moduleId: 'tpl-1', tagIds: ['tag-a'], product: `${SRC}:a1b2c3d4e5` })
    expect(parseSheetProductRef(parseTriggerModuleData(data).product)).toEqual({ sourceId: SRC, productId: 'a1b2c3d4e5' })
    expect(parseTriggerModuleData(encodeTriggerModule('tpl-1', ['tag-a']))).toEqual({ moduleId: 'tpl-1', tagIds: ['tag-a'] })
    expect(encodeTriggerModule('tpl-1', ['tag-a'])).toBe('triggerModule=tpl-1&tags=tag-a')
  })

  it('最長的情況也塞得進 LINE 的 300 字（模組 id、標籤 id、來源 id 都是 36 字的 uuid）', () => {
    const uuid = '6f1c2d3e-aaaa-bbbb-cccc-1234567890ab'
    expect(encodeTriggerModule(uuid, [uuid], sheetProductRef(uuid, 'a1b2c3d4e5')).length).toBeLessThan(LINE_POSTBACK_DATA_MAX)
  })

  it('壞的商品代號解不出來＝null', () => {
    expect(parseSheetProductRef('沒有冒號')).toBeNull()
    expect(parseSheetProductRef(undefined)).toBeNull()
  })
})

describe('④ 存檔檢查', () => {
  const sheetMsg = (s: Record<string, unknown>) => ({ type: 'flexImageCarousel', enableImage: true, columns: [], sheetSource: s })
  it('照試算表排：不看卡片（0 張也可以存），只看兩格', () => {
    expect(cardMessageError(sheetMsg({ sourceId: SRC, tapModuleId: 'tpl-1' }))).toBe('')
    expect(cardMessageError(sheetMsg({ sourceId: '', tapModuleId: 'tpl-1' }))).toBe('商品目錄：請選擇要照哪一份試算表排')
    expect(sheetCatalogError(sheetMsg({ sourceId: SRC, tapModuleId: '' }))).toBe('商品目錄：請選擇點卡片要送的模組')
  })
  it('對照組：自己一張張做的照舊（0 張不能存）', () => {
    expect(cardMessageError({ type: 'flexImageCarousel', columns: [] })).toBe('卡片訊息：至少要有 1 張卡')
    expect(readSheetCatalogSource({ type: 'flexImageCarousel', columns: [] })).toBeNull()
  })
})

describe('⑤ 標籤名稱', () => {
  it('開頭＋商品名；沒開頭就是商品名；太長截到 50 字', () => {
    expect(sheetProductTagName('客服 - ', 'BOYA mini2')).toBe('客服 - BOYA mini2')
    expect(sheetProductTagName(undefined, 'BOYA mini2')).toBe('BOYA mini2')
    expect([...sheetProductTagName('', 'x'.repeat(80))]).toHaveLength(50)
  })
})
