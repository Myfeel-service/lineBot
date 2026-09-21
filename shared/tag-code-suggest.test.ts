import { describe, expect, it } from 'vitest'
import {
  TAG_CODE_MAX_LENGTH,
  isValidTagCode,
  suggestTagCode,
  tagCodeBase,
} from './tag-code-suggest'

describe('tagCodeBase', () => {
  it('英文名字直接壓成小寫底線', () => {
    expect(tagCodeBase('VIP Customer')).toBe('vip_customer')
    expect(tagCodeBase('asked shipping status')).toBe('asked_shipping_status')
  })

  it('中英混雜只留得到 ASCII 的那一段（正式庫的標籤長這樣）', () => {
    // 「問卷 - 乾淨方MAX」是 MYFEEL 真的在用的標籤名
    expect(tagCodeBase('問卷 - 乾淨方MAX')).toBe('max')
    expect(tagCodeBase('客服 - BOYA mini2')).toBe('boya_mini2')
  })

  it('純中文取不到東西就回空字串，由呼叫端決定退路', () => {
    expect(tagCodeBase('問過出貨進度')).toBe('')
    expect(tagCodeBase('　')).toBe('')
    expect(tagCodeBase('')).toBe('')
  })

  it('開頭不可以是數字或底線', () => {
    expect(tagCodeBase('2026 spring')).toBe('spring')
    expect(tagCodeBase('_vip')).toBe('vip')
    expect(tagCodeBase('123')).toBe('')
  })

  it('連續的符號收斂成一個底線、頭尾不留底線', () => {
    expect(tagCodeBase('vip -- gold //')).toBe('vip_gold')
    expect(tagCodeBase('a😀b')).toBe('a_b')
  })

  it('超過上限要截短，而且截完不可以留尾巴底線', () => {
    const base = tagCodeBase('abcdefghij klmnopqrst uvwxyz')
    expect(base.length).toBeLessThanOrEqual(TAG_CODE_MAX_LENGTH)
    expect(base.endsWith('_')).toBe(false)
  })
})

describe('suggestTagCode', () => {
  it('沒撞號就直接用名字壓出來的', () => {
    expect(suggestTagCode('VIP Customer', [])).toBe('vip_customer')
  })

  it('純中文名字退回 tag', () => {
    expect(suggestTagCode('問過出貨進度', [])).toBe('tag')
  })

  it('撞號往下加序號', () => {
    expect(suggestTagCode('問過出貨進度', ['tag'])).toBe('tag_2')
    expect(suggestTagCode('問過出貨進度', ['tag', 'tag_2'])).toBe('tag_3')
    expect(suggestTagCode('VIP', ['vip'])).toBe('vip_2')
  })

  it('比對代號時不分大小寫與前後空白（清單是從 API 撈回來的）', () => {
    expect(suggestTagCode('VIP', [' VIP ', 'other'])).toBe('vip_2')
  })

  it('⛔ 加了序號也不可以超過長度上限', () => {
    const existing = ['abcdefghij_klmnopqrst_uv']
    const code = suggestTagCode('abcdefghij klmnopqrst uvwxyz', existing)
    expect(code.length).toBeLessThanOrEqual(TAG_CODE_MAX_LENGTH)
    expect(existing).not.toContain(code)
  })

  it('⛔ 任何輸入吐出來的都必須通過後端那條規則（幫他填一個會被退件的值才是最糟的）', () => {
    const names = [
      'VIP Customer', '問過出貨進度', '2026 spring', '_vip', '123', '',
      '　', 'a😀b', '問卷 - 乾淨方MAX', '客服 - ⟣ 粒粒安 ⟢ 飛利浦 無塗層',
      '---', '__', '9lives', 'MATELASER《筋牌特務》W1 REGEN',
    ]
    for (const name of names) {
      expect(isValidTagCode(suggestTagCode(name, [])), `「${name}」`).toBe(true)
      expect(isValidTagCode(suggestTagCode(name, ['tag', 'max', 'vip'])), `「${name}」撞號後`).toBe(true)
    }
  })

  it('⛔ 連續建立同一個中文名字時，每一顆都要拿到不同代號', () => {
    const taken: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const code = suggestTagCode('問過出貨進度', taken)
      expect(taken).not.toContain(code)
      taken.push(code)
    }
    expect(taken).toEqual(['tag', 'tag_2', 'tag_3', 'tag_4', 'tag_5'])
  })
})
