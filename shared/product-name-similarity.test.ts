import { describe, it, expect } from 'vitest'
import {
  boundedEditDistance,
  findSimilarProductName,
  likelyTypoDistance,
  normalizeProductName,
  typoDistanceLimit,
} from './product-name-similarity'

describe('boundedEditDistance', () => {
  it('相同字串距離 0', () => {
    expect(boundedEditDistance('gplus', 'gplus', 2)).toBe(0)
  })
  it('一個替換 = 1、相鄰對調 = 2（打字最常見的兩種手滑）', () => {
    expect(boundedEditDistance('gplus', 'gplas', 2)).toBe(1)
    expect(boundedEditDistance('gplus', 'gplsu', 2)).toBe(2)
  })
  it('超過上限提早回 max+1（不用算完整距離）', () => {
    expect(boundedEditDistance('abcdefgh', 'zzzzzzzz', 2)).toBe(3)
    expect(boundedEditDistance('很長的一個名字', '完全不同的字', 1)).toBe(2)
  })
  it('長度差超過上限直接出局', () => {
    expect(boundedEditDistance('ab', 'abcdef', 2)).toBe(3)
  })
})

describe('typoDistanceLimit', () => {
  it('短名字不判打錯字（W1 差一個字就是另一台）', () => {
    expect(typoDistanceLimit(2)).toBe(0)
    expect(typoDistanceLimit(3)).toBe(0)
  })
  it('中長名字容忍 1，長名字容忍 2', () => {
    expect(typoDistanceLimit(4)).toBe(1)
    expect(typoDistanceLimit(7)).toBe(1)
    expect(typoDistanceLimit(8)).toBe(2)
  })
})

describe('likelyTypoDistance', () => {
  it('字母打反（GPLSU vs GPLUS）判為可能打錯字', () => {
    expect(likelyTypoDistance('GPLSU 智慧除濕機 12L', 'GPLUS 智慧除濕機 12L')).toBe(2)
  })
  it('數字不同（12L vs 16L）不算打錯字——多半是同系列不同型號', () => {
    expect(likelyTypoDistance('GPLUS 智慧除濕機 12L', 'GPLUS 智慧除濕機 16L')).toBeNull()
  })
  it('一個包含另一個的不搶答（那是包含訊號的守備範圍，會標型號風險）', () => {
    expect(likelyTypoDistance('W1 REGEN', 'W1 REGEN ULTRA')).toBeNull()
  })
  it('正規化後相同的不算（只差空白/符號，本來就當同一台）', () => {
    expect(likelyTypoDistance('MATELASER《筋牌特務》W1 REGEN', 'MATELASER 筋牌特務 W1 REGEN')).toBeNull()
  })
  it('短名字差一個字是另一台，不判打錯字', () => {
    expect(likelyTypoDistance('ABC', 'ABD')).toBeNull()
  })
  it('差太多的不判', () => {
    expect(likelyTypoDistance('GPLUS 智慧除濕機', '威技高效抽取型除濕機')).toBeNull()
  })
})

describe('findSimilarProductName', () => {
  const existing = ['GPLUS 智慧除濕機 12L', 'NWT 威技 16L 除濕機', 'MATELASER 筋牌特務 W1 REGEN']

  it('打錯字 → typo，並回最像的那個', () => {
    const v = findSimilarProductName('GPLSU 智慧除濕機 12L', existing)
    expect(v).not.toBeNull()
    expect(v!.kind).toBe('typo')
    expect(v!.match).toBe('GPLUS 智慧除濕機 12L')
    expect(v!.distance).toBe(2)
  })
  it('只差空白/符號 → spelling（AI 本來就當同一台，建議統一寫法）', () => {
    const v = findSimilarProductName('MATELASER《筋牌特務》 W1 REGEN', existing)
    expect(v).not.toBeNull()
    expect(v!.kind).toBe('spelling')
    expect(v!.match).toBe('MATELASER 筋牌特務 W1 REGEN')
  })
  it('原樣完全等於現成名 → null（那是「就是它」，不是「像」）', () => {
    expect(findSimilarProductName('GPLUS 智慧除濕機 12L', existing)).toBeNull()
  })
  it('全新名字 → null', () => {
    expect(findSimilarProductName('小米空氣清淨機 4 Pro', existing)).toBeNull()
  })
  it('空輸入 → null', () => {
    expect(findSimilarProductName('  ', existing)).toBeNull()
  })
})
