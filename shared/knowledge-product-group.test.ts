/**
 * 資料夾當「商品」分組：該不該補產品名、補成什麼（`C-320`）。
 * 例子都是 MYFEEL 正式站的資料夾與產品名（2026-10-15 唯讀試算）。
 */
import { describe, expect, it } from 'vitest'
import {
  decideGroupProductName,
  distinctGroupProductNames,
  findLikelyDuplicateGroups,
  looksLikeGeneralGroupName,
} from './knowledge-product-group'

const group = { general: false }

describe('decideGroupProductName', () => {
  it('同組其他資料只有一種產品名 → 補成那一個', () => {
    expect(decideGroupProductName({
      productName: '',
      group,
      siblingProductNames: ['珈樂堤 小滑手全自動義式咖啡機', '珈樂堤 小滑手全自動義式咖啡機', ''],
    })).toEqual({ action: 'fill', productName: '珈樂堤 小滑手全自動義式咖啡機' })
  })

  it('⛔ 已經填好的不覆蓋（就算跟同組其他的不一樣）', () => {
    expect(decideGroupProductName({ productName: '小滑手', group, siblingProductNames: ['珈樂堤 小滑手全自動義式咖啡機'] }))
      .toEqual({ action: 'keep', reason: 'has-name' })
  })

  it('⛔ 同組兩款（MATELASER 資料夾裡是 W1 REGEN 與 W1 REGEN ULTRA）→ 不補、列出來問', () => {
    expect(decideGroupProductName({
      productName: '',
      group,
      siblingProductNames: ['MATELASER W1 REGEN', 'MATELASER W1 REGEN ULTRA', 'MATELASER W1 REGEN'],
    })).toEqual({ action: 'ask', reason: 'ambiguous', names: ['MATELASER W1 REGEN', 'MATELASER W1 REGEN ULTRA'] })
  })

  it('同組沒有人填過 → 不補（⛔ 不拿資料夾名頂替）', () => {
    expect(decideGroupProductName({ productName: '', group, siblingProductNames: ['', null, undefined] }))
      .toEqual({ action: 'ask', reason: 'no-names', names: [] })
  })

  it('通用分組、未分類、型錄 → 不補', () => {
    const siblings = ['SHARP 乾淨方MAX']
    expect(decideGroupProductName({ productName: '', group: { general: true }, siblingProductNames: siblings })).toEqual({ action: 'keep', reason: 'general' })
    expect(decideGroupProductName({ productName: '', group: null, siblingProductNames: siblings })).toEqual({ action: 'keep', reason: 'no-group' })
    expect(decideGroupProductName({ productName: '', group, isCatalog: true, siblingProductNames: siblings })).toEqual({ action: 'keep', reason: 'catalog' })
  })

  it('⛔ Google 試算表 → 不補（多商品價目表拖進某一組，補了整張表會被標成那一台；/code-review 第 1 條）', () => {
    expect(decideGroupProductName({ productName: '', group, isSheet: true, siblingProductNames: ['SHARP 乾淨方MAX'] })).toEqual({ action: 'keep', reason: 'sheet' })
  })

  it('只差空白／大小寫／標點算同一種，補成最多份用的寫法', () => {
    expect(decideGroupProductName({
      productName: '  ',
      group,
      siblingProductNames: ['Sharp 乾淨方 MAX', 'SHARP 乾淨方MAX', 'SHARP 乾淨方MAX'],
    })).toEqual({ action: 'fill', productName: 'SHARP 乾淨方MAX' })
  })

  it('別名確認過是同一台的算一種（伺服器傳 canonicalProductName 進來）', () => {
    const canonical = (n: string) => (n === '上好ㄟ抽取式除濕機' ? 'NWT 威技 新一級能效 16L' : n)
    expect(decideGroupProductName({
      productName: '',
      group,
      siblingProductNames: ['上好ㄟ抽取式除濕機', 'NWT 威技 新一級能效 16L'],
      canonical,
    })).toEqual({ action: 'fill', productName: 'NWT 威技 新一級能效 16L' })
    // 沒給別名就是兩種 → 不補
    expect(decideGroupProductName({
      productName: '',
      group,
      siblingProductNames: ['上好ㄟ抽取式除濕機', 'NWT 威技 新一級能效 16L'],
    }).action).toBe('ask')
  })
})

describe('distinctGroupProductNames', () => {
  it('照份數多到少排', () => {
    expect(distinctGroupProductNames(['B', 'A', 'B', '', 'C', 'B', 'A'])).toEqual(['B', 'A', 'C'])
  })
})

describe('looksLikeGeneralGroupName', () => {
  it.each(['客服', '總覽', '常見問題 FAQ', 'FAQ', '公告', '價目表'])('通用：%s', (n) => {
    expect(looksLikeGeneralGroupName(n)).toBe(true)
  })
  it.each(['小滑手', 'SHARP 自動調理零水鍋', 'MATELASER', '乾淨方MAX', '小耳記', 'AquaPure'])('商品：%s', (n) => {
    expect(looksLikeGeneralGroupName(n)).toBe(false)
  })
})

describe('findLikelyDuplicateGroups', () => {
  const g = (id: string, name: string, productNames: string[] = [], general = false) => ({ id, name, productNames, general })

  it('「零水鍋」與「SHARP 自動調理零水鍋」→ 列為可能同一個', () => {
    expect(findLikelyDuplicateGroups([g('a', '零水鍋'), g('b', 'SHARP 自動調理零水鍋'), g('c', '小滑手')]))
      .toEqual([{ a: 'a', b: 'b', why: 'name' }])
  })

  it('只多了型號尾巴（MAX、ULTRA）＝另一款，不列', () => {
    expect(findLikelyDuplicateGroups([g('a', '乾淨方'), g('b', '乾淨方MAX'), g('c', 'W1 REGEN'), g('d', 'W1 REGEN ULTRA')])).toEqual([])
  })

  it('兩組裡有同一個產品名 → 列', () => {
    expect(findLikelyDuplicateGroups([g('a', '電淨艙', ['奇美 靜電集塵空氣清淨機 AP-08SPFG']), g('b', '奇美清淨機', ['奇美 靜電集塵空氣清淨機 AP-08SPFG'])]))
      .toEqual([{ a: 'a', b: 'b', why: 'product' }])
  })

  it('通用分組不比', () => {
    expect(findLikelyDuplicateGroups([g('a', '客服', [], true), g('b', '客服中心')])).toEqual([])
  })
})
