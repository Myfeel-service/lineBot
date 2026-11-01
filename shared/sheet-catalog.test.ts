import { describe, expect, it } from 'vitest'
import { encodeTriggerModule, parseTriggerModuleData, LINE_POSTBACK_DATA_MAX } from './action-schema'
import { cardMessageError } from './card-message'
import {
  hasSheetCatalogIssues,
  parseSheetProductRef,
  planSheetCatalog,
  sheetCatalogIssues,
  readSheetCatalogSource,
  sheetCatalogColumns,
  sheetCatalogError,
  sheetCatalogSyncNote,
  sheetCoverStatusText,
  sheetLockedText,
  sheetProductChangeText,
  sheetProductRef,
  sheetProductTagName,
} from './sheet-catalog'
import { applyCoverResult, reconcileSheetProducts, retireSheetProduct, setOwnProductImage, type SheetProductRegistry } from './sheet-products'

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

describe('編輯畫面的白話', () => {
  it('最近的變動：每一種都講得出來，改名講舊名→新名', () => {
    const at = 1
    expect(sheetProductChangeText({ at, kind: 'added', productId: 'x', title: 'BOYA mini2' })).toBe('新增「BOYA mini2」')
    expect(sheetProductChangeText({ at, kind: 'renamed', productId: 'x', title: '10S Pro', prevTitle: '10S' })).toBe('「10S」改名成「10S Pro」，已接上，圖和標籤照舊')
    expect(sheetProductChangeText({ at, kind: 'catalogOff', productId: 'x', title: 'A' })).toBe('「A」取消勾選，拿出目錄')
    expect(sheetProductChangeText({ at, kind: 'renameUnsure', productId: 'x', title: 'A' })).toContain('是改名嗎')
  })
  it('沒圖的原因：沒有商品頁網址、還在抓、找不到封面圖各講各的', () => {
    expect(sheetCoverStatusText({ hasPageUrl: false, coverError: null })).toContain('試算表上沒有商品頁網址')
    expect(sheetCoverStatusText({ hasPageUrl: true, coverError: null })).toContain('正在抓')
    expect(sheetCoverStatusText({ hasPageUrl: true, coverError: { reason: 'noCover', attempts: 1 } })).toContain('找不到封面圖')
    expect(sheetCoverStatusText({ hasPageUrl: true, coverError: { reason: 'pageUnreachable', attempts: 3 } })).toContain('連不上商品頁')
  })
  it('`C-453`⑤：認不出哪一欄是商品頁（欄名叫「官網」）不講「沒有商品頁網址」——他明明有填；講欄名要有「商品頁」', () => {
    const t = sheetCoverStatusText({ hasPageUrl: false, coverError: null }, false)
    expect(t).toContain('欄名裡要有「商品頁」')
    expect(t).not.toContain('試算表上沒有商品頁網址')
  })
  it('`C-453`②：改了試算表要等多久——照這份的自動更新間隔講；沒開自動更新講要自己按', () => {
    expect(sheetCatalogSyncNote(60)).toContain('約一小時內')
    expect(sheetCatalogSyncNote(120)).toContain('約 2 小時內')
    expect(sheetCatalogSyncNote(30)).toContain('約 30 分鐘內')
    expect(sheetCatalogSyncNote(60)).toContain('封面圖')
    expect(sheetCatalogSyncNote(null)).toContain('沒有開自動更新')
  })
  it('`C-453`①：被手動改過的商品——講後果（LINE 跟 AI 都不跟）；超過 3 個講總數', () => {
    expect(sheetLockedText(['KIESLECT'])).toBe('「KIESLECT」在知識庫被手動改過：試算表改了也不會跟著變，LINE 上的商品資訊和 AI 的回答都停在手動改的那一版。')
    expect(sheetLockedText(['A', 'B', 'C', 'D'])).toContain('「A」、「B」、「C」 等 4 個')
  })
})

describe('`C-438` 商品目錄要店家處理的事（提醒中心跟模組頁同一支）', () => {
  it('放不下：第 11 個以後；勾了沒圖但還在抓的不算（不然每上一個新商品就先亮一次）', () => {
    const rows = Array.from({ length: 11 }, (_, i) => [`商品${i + 1}`, true, true] as [string, boolean, boolean])
    const reg = registry([...rows, ['新的', true, false]])
    expect(sheetCatalogIssues(reg)).toEqual({ overflow: ['商品11'], noImage: [], missing: [], renameUnsure: [] })
  })

  it('抓不到圖＝系統不會再自己抓到了：沒填商品頁網址、找不到封面圖、試滿三次', () => {
    let reg = registry([['沒網址', true, false], ['找不到', true, false], ['連不上', true, false], ['還在試', true, false]])
    const byTitle = (t: string) => Object.values(reg.products).find(p => p.title === t)!
    reg.products[byTitle('沒網址').id] = { ...byTitle('沒網址'), pageUrl: null, urlKey: null }
    reg = applyCoverResult(reg, byTitle('找不到').id, byTitle('找不到').urlKey!, { ok: false, reason: 'noCover' }, 2000)!
    for (let i = 0; i < 3; i++) reg = applyCoverResult(reg, byTitle('連不上').id, byTitle('連不上').urlKey!, { ok: false, reason: 'pageUnreachable' }, 2000)!
    reg = applyCoverResult(reg, byTitle('還在試').id, byTitle('還在試').urlKey!, { ok: false, reason: 'pageUnreachable' }, 2000)!
    expect(sheetCatalogIssues(reg).noImage).toEqual(['沒網址', '找不到', '連不上'])
  })

  it('表上找不到：要問「是改名嗎？」的分開列（名字跟網址一起改了）', () => {
    let reg = registry([['A', true, true], ['B', true, true]])
    // A 被刪掉、B 改了名字也換了網址（同一輪多了「B2」）
    reg = reconcileSheetProducts(reg, { rows: [{ title: 'B2', pageUrl: 'https://a.com/B2', inCatalog: true }], catalogColumn: true, pageHeader: '商品頁面' }, 2000, ids).registry
    const issues = sheetCatalogIssues(reg)
    expect(issues.renameUnsure.sort()).toEqual(['A', 'B'])
    expect(issues.missing).toEqual([])
    expect(hasSheetCatalogIssues(issues)).toBe(true)
    expect(hasSheetCatalogIssues(sheetCatalogIssues(registry([['C', true, true]])))).toBe(false)
  })

  it('「不賣了，拿掉」：只收表上找不到的；拿掉之後不再列、記一筆變動，別人的候選裡也拿掉', () => {
    let reg = registry([['A', true, true], ['B', true, true]])
    const a = Object.values(reg.products).find(p => p.title === 'A')!
    const b = Object.values(reg.products).find(p => p.title === 'B')!
    expect(retireSheetProduct(reg, b.id, 3000)).toBeNull() // 還在表上
    reg = reconcileSheetProducts(reg, { rows: [{ title: 'B', pageUrl: 'https://a.com/B', inCatalog: true }], catalogColumn: true, pageHeader: '商品頁面' }, 2000, ids).registry
    expect(sheetCatalogIssues(reg).missing).toEqual(['A'])
    const next = retireSheetProduct(reg, a.id, 3000)!
    expect(next.products[a.id]).toBeUndefined()
    expect(sheetCatalogIssues(next).missing).toEqual([])
    expect(sheetProductChangeText(next.changes[0]!)).toBe('「A」不賣了，拿掉')
  })

  it('`C-438` code review：候選本身也不見了＝不再問「是改名嗎？」（提醒跟畫面同一把尺）；拿掉候選時從別人的候選裡一起拿掉', () => {
    let reg = registry([['X', true, true]])
    // X 不見、同一輪多了 Y → X 問「是改名嗎？」（候選 Y）
    reg = reconcileSheetProducts(reg, { rows: [{ title: 'Y', pageUrl: 'https://a.com/Y', inCatalog: true }], catalogColumn: true, pageHeader: '商品頁面' }, 2000, ids).registry
    expect(sheetCatalogIssues(reg).renameUnsure).toEqual(['X'])
    // Y 也不見了 → 候選沒有還在表上的 → X 算「少了」，⛔ 不再亮「是改名嗎？」（畫面上也沒有按鈕可按）
    reg = reconcileSheetProducts(reg, { rows: [], catalogColumn: true, pageHeader: '商品頁面' }, 3000, ids).registry
    expect(sheetCatalogIssues(reg)).toMatchObject({ renameUnsure: [], missing: ['X', 'Y'] })
    // 按 Y「不賣了」→ X 的候選裡也拿掉
    const y = Object.values(reg.products).find(p => p.title === 'Y')!
    const x = Object.values(reg.products).find(p => p.title === 'X')!
    const next = retireSheetProduct(reg, y.id, 4000)!
    expect(next.products[x.id]!.renameCandidates).toBeUndefined()
    expect(sheetCatalogIssues(next)).toMatchObject({ renameUnsure: [], missing: ['X'] })
  })
})

describe('⑤ 標籤名稱', () => {
  it('開頭＋商品名；沒開頭就是商品名；太長截到 50 字', () => {
    expect(sheetProductTagName('客服 - ', 'BOYA mini2')).toBe('客服 - BOYA mini2')
    expect(sheetProductTagName(undefined, 'BOYA mini2')).toBe('BOYA mini2')
    expect([...sheetProductTagName('', 'x'.repeat(80))]).toHaveLength(50)
  })
})
