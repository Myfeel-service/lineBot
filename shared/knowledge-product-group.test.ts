/**
 * 分組就是商品（`D-127`）：每份資料的商品名＝組名；還有搬家腳本用的幾個判斷。
 * 例子都是 MYFEEL 正式站的分組與產品名（2026-10-15／16 唯讀試算）。
 */
import { describe, expect, it } from 'vitest'
import {
  distinctGroupProductNames,
  findLikelyDuplicateGroups,
  isVariantPair,
  looksLikeGeneralGroupName,
  productNameForGroup,
  sameProductGroupName,
} from './knowledge-product-group'

describe('productNameForGroup（`D-127`）', () => {
  it('商品分組＝組名（就算這份原本寫的是含型號的全名，也照組名走）', () => {
    expect(productNameForGroup({ name: '上好ㄟ抽取式除濕機' })).toBe('上好ㄟ抽取式除濕機')
    expect(productNameForGroup({ name: '  SHARP   自動調理零水鍋 ', general: false })).toBe('SHARP 自動調理零水鍋')
  })

  it('通用、未分類＝不是講單一商品（空的）', () => {
    expect(productNameForGroup({ name: '客服', general: true })).toBe('')
    expect(productNameForGroup(null)).toBe('')
  })

  it('⛔ 型錄、Google 試算表放在哪一組都不當成那一台（一份講很多台；/code-review 第 1 條）', () => {
    expect(productNameForGroup({ name: 'SHARP 乾淨方MAX' }, { isCatalog: true })).toBe('')
    expect(productNameForGroup({ name: 'SHARP 乾淨方MAX' }, { isSheet: true })).toBe('')
  })
})

describe('sameProductGroupName', () => {
  it('只差空白、符號、大小寫＝同一組', () => {
    expect(sameProductGroupName('SHARP 自動調理零水鍋', 'sharp自動調理零水鍋')).toBe(true)
    expect(sameProductGroupName('MATELASER W1 REGEN', 'MATELASER W1 REGEN ULTRA')).toBe(false)
    expect(sameProductGroupName('', '')).toBe(false)
  })
})

describe('isVariantPair（`D-127` 搬家：一組裡是兩款就拆）', () => {
  it('只差型號尾巴＝兩款', () => {
    expect(isVariantPair('MATELASER 筋牌特務 W1 REGEN', 'MATELASER 筋牌特務 W1 REGEN ULTRA')).toBe(true)
  })
  it('寫法不同、互不包含＝同一台的不同寫法（MYFEEL 奇美、上好ㄟ那兩組）', () => {
    expect(isVariantPair('CHIMEI 靜電集塵空氣清淨機 AP-08SPFG (電淨艙)', '奇美 靜電集塵空氣清淨機 AP-08SPFG')).toBe(false)
    expect(isVariantPair('NWT 威技 新一級能效 16L 高效抽取型除濕機', 'NWT 威技 除濕機')).toBe(false)
    expect(isVariantPair('BOYA mini2', 'BOYA mini2')).toBe(false)
  })
})

describe('distinctGroupProductNames', () => {
  it('照份數多到少排', () => {
    expect(distinctGroupProductNames(['B', 'A', 'B', '', 'C', 'B', 'A'])).toEqual(['B', 'A', 'C'])
  })
  it('別名確認過是同一台的算一種', () => {
    const canonical = (n: string) => (n === '上好ㄟ抽取式除濕機' ? 'NWT 威技 新一級能效 16L' : n)
    expect(distinctGroupProductNames(['上好ㄟ抽取式除濕機', 'NWT 威技 新一級能效 16L'], canonical)).toEqual(['NWT 威技 新一級能效 16L'])
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
