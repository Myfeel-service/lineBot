/**
 * 知識庫「分組」與商品名叫法的純函式（`C-406` 從知識庫頁搬出來時補的測試）。
 *
 * 為什麼值得測：這幾支錯了畫面不會報錯，只會「合錯一台」——正式名挑成舊全名、
 * 下拉列出已經是這一台的名字、叫法沒改卻被當成有改。以前寫在頁面裡測不到。
 */
import { describe, expect, it } from 'vitest'
import {
  buildGroupAliasRows,
  groupAliasDiff,
  type GroupAliasRow,
  groupAliasOptions,
  groupNameFirst,
  type KbFolderRow,
  productGroupNamed,
  sameAliasPair,
} from './kb-product-groups'

const folder = (id: string, name: string, general = false): KbFolderRow => ({ id, name, order: 0, createdAtMs: 0, general })
const FOLDERS = [
  folder('g1', 'W1 REGEN'),
  folder('g2', '客服 FAQ', true),
  folder('g3', 'SHARP 乾淨方MAX'),
]
const row = (product: string, original: string[], current = [...original], draft = ''): GroupAliasRow => ({ product, original, current, draft })

describe('productGroupNamed：名字就是這個的商品分組', () => {
  it('不分空白、符號、大小寫', () => {
    expect(productGroupNamed(FOLDERS, 'w1-regen')?.id).toBe('g1')
    expect(productGroupNamed(FOLDERS, 'SHARP 乾淨方 MAX')?.id).toBe('g3')
  })

  it('通用那一組不算商品分組（就算名字一樣）', () => {
    expect(productGroupNamed(FOLDERS, '客服 FAQ')).toBeNull()
  })

  it('沒有這一組 → null', () => {
    expect(productGroupNamed(FOLDERS, 'W1 REGEN ULTRA')).toBeNull()
  })
})

describe('groupNameFirst：組名排前面＝合併後的正式名（/code-review 第 6 條）', () => {
  it('b 是組名、a 不是 → 對調（以前拿較長的舊全名當正式名，組名反被收成別名）', () => {
    const c = groupNameFirst(FOLDERS, { a: '筋牌特務 W1 REGEN 紅光治療儀', b: 'W1 REGEN' })
    expect(c).toEqual({ a: 'W1 REGEN', b: '筋牌特務 W1 REGEN 紅光治療儀' })
  })

  it('a 已經是組名、或兩個都是／都不是 → 原樣', () => {
    expect(groupNameFirst(FOLDERS, { a: 'W1 REGEN', b: '紅光槍' })).toEqual({ a: 'W1 REGEN', b: '紅光槍' })
    expect(groupNameFirst(FOLDERS, { a: 'W1 REGEN', b: 'SHARP 乾淨方MAX' })).toEqual({ a: 'W1 REGEN', b: 'SHARP 乾淨方MAX' })
    expect(groupNameFirst(FOLDERS, { a: '甲', b: '乙' })).toEqual({ a: '甲', b: '乙' })
  })

  it('其他欄位跟著留下', () => {
    const c = groupNameFirst(FOLDERS, { key: 'k', a: '舊全名', b: 'W1 REGEN', reason: 'r' })
    expect(c).toEqual({ key: 'k', a: 'W1 REGEN', b: '舊全名', reason: 'r' })
  })
})

describe('sameAliasPair：同一組名字（不分先後、不分寫法）', () => {
  it('先後對調、寫法不同都算同一組', () => {
    expect(sameAliasPair({ a: 'W1 REGEN', b: '紅光槍' }, { a: '紅光槍', b: 'w1-regen' })).toBe(true)
  })

  it('只要有一個名字不同就不是', () => {
    expect(sameAliasPair({ a: 'W1 REGEN', b: '紅光槍' }, { a: 'W1 REGEN ULTRA', b: '紅光槍' })).toBe(false)
  })
})

describe('buildGroupAliasRows：一組一列，列出指向組名的叫法', () => {
  const pairs = [
    { aliasKey: '紅光槍', alias: '紅光槍', canonical: 'W1 REGEN' },
    { aliasKey: 'w1紅光', alias: 'W1 紅光', canonical: 'w1-regen' },
    { aliasKey: '零水鍋', alias: '零水鍋', canonical: 'SHARP 零水鍋' },
  ]

  it('只收指向這一組（不分寫法）的，原樣寫法；現在＝打開時那一份的複本', () => {
    const rows = buildGroupAliasRows(folder('g1', 'W1 REGEN'), pairs)
    expect(rows).toEqual([{ product: 'W1 REGEN', original: ['紅光槍', 'W1 紅光'], current: ['紅光槍', 'W1 紅光'], draft: '' }])
    expect(rows[0]!.current).not.toBe(rows[0]!.original)
  })

  it('組名正規化後是空的 → 沒有列', () => {
    expect(buildGroupAliasRows(folder('x', '（）'), pairs)).toEqual([])
  })
})

describe('groupAliasOptions：下拉可以挑的其他商品名', () => {
  const names = ['W1 REGEN', '紅光槍', 'SHARP 零水鍋', '乾淨方MAX', '舊名字']
  /** 「舊名字」已經是 W1 REGEN 的別名 */
  const finalOf = new Map([['舊名字', 'W1 REGEN']])

  it('不列自己、不列已經在框裡的、不列已經指向這一台的', () => {
    expect(groupAliasOptions(row('W1 REGEN', ['紅光槍']), names, finalOf)).toEqual(['SHARP 零水鍋', '乾淨方MAX'])
  })

  it('別台的別名照樣列（挑了＝改當成這一台）', () => {
    expect(groupAliasOptions(row('乾淨方MAX', []), names, finalOf)).toEqual(['W1 REGEN', '紅光槍', 'SHARP 零水鍋', '舊名字'])
  })
})

describe('groupAliasDiff：跟打開時比加了／拿掉哪些', () => {
  it('沒動 → 都空', () => {
    expect(groupAliasDiff(row('W1 REGEN', ['紅光槍']))).toEqual({ added: [], removed: [] })
  })

  it('只改寫法（大小寫、空白）不算改', () => {
    expect(groupAliasDiff(row('W1 REGEN', ['W1 紅光'], ['w1紅光']))).toEqual({ added: [], removed: [] })
  })

  it('加一個、拿掉一個', () => {
    expect(groupAliasDiff(row('W1 REGEN', ['紅光槍', '舊名字'], ['紅光槍', '紅光儀']))).toEqual({ added: ['紅光儀'], removed: ['舊名字'] })
  })
})
