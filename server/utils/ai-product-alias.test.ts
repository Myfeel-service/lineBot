import { describe, it, expect } from 'vitest'
import {
  canonicalProductName,
  detectAliasCandidates,
  normalizeProductName,
  aliasPairKey,
  type ProductAliasMap,
} from './ai-product-alias'

const emptyMap = (): ProductAliasMap => ({ aliases: {}, aliasLabels: {}, dismissedPairs: [] })

describe('normalizeProductName', () => {
  it('去掉裝飾符號與空白後比對', () => {
    expect(normalizeProductName('MATELASER《筋牌特務》 W1 REGEN'))
      .toBe(normalizeProductName('MATELASER 筋牌特務 W1 REGEN'))
  })
  it('大小寫不敏感', () => {
    expect(normalizeProductName('BOYA mini2')).toBe(normalizeProductName('boya MINI2'))
  })
})

describe('aliasPairKey', () => {
  it('與順序無關', () => {
    expect(aliasPairKey('A 產品', 'B 產品')).toBe(aliasPairKey('B 產品', 'A 產品'))
  })
})

describe('detectAliasCandidates', () => {
  it('訊號1:來源檔名用「｜」並列兩個叫法 → 高信心候選,長的當正式名', () => {
    const out = detectAliasCandidates({
      sources: [{ name: '上好ㄟ抽取式除濕機｜NWT 威技 新一級能效 16L 高效抽取型除濕機 (WDH31B16E）-說明書.pdf' }],
      productNames: [],
      aliasMap: emptyMap(),
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.confidence).toBe('high')
    expect(out[0]!.a).toContain('NWT 威技') // 較完整的當正式名
    expect(out[0]!.b).toBe('上好ㄟ抽取式除濕機')
    expect(out[0]!.variantRisk).toBe(false)
  })

  it('網址來源的標題不吃訊號1:商城標題慣用「｜」分隔品名與站名,誤判會把站名併成產品', () => {
    const out = detectAliasCandidates({
      sources: [{ type: 'url', name: 'NWT 威技 16L 除濕機｜MiniMe 官方購物網' }],
      productNames: [],
      aliasMap: emptyMap(),
    })
    expect(out).toHaveLength(0)
  })

  it('訊號1 的正式名會對齊既有產品名(檔名多帶括號型號時不可生出第三個名字)', () => {
    const out = detectAliasCandidates({
      sources: [{
        type: 'file',
        name: '上好ㄟ抽取式除濕機｜NWT 威技 新一級能效 16L 高效抽取型除濕機 (WDH31B16E）-說明書.pdf',
      }],
      // 卡片上實際存的是不含型號的寫法
      productNames: ['NWT 威技 新一級能效 16L 高效抽取型除濕機'],
      aliasMap: emptyMap(),
    })
    expect(out).toHaveLength(1)
    // 若原樣採用檔名片段,合併後卡片的舊寫法查不到對照 → 分組照樣分兩邊,等於沒生效
    expect(out[0]!.a).toBe('NWT 威技 新一級能效 16L 高效抽取型除濕機')
  })

  it('只差標點/空白的寫法不列候選(答題端正規化後已自動視為同一台,不該浪費一次確認)', () => {
    const out = detectAliasCandidates({
      sources: [],
      productNames: ['MATELASER《筋牌特務》 W1 REGEN', 'MATELASER 筋牌特務 W1 REGEN'],
      aliasMap: emptyMap(),
    })
    expect(out).toHaveLength(0)
  })

  it('訊號2:一個包含另一個 → 中信心;多出來的部分含型號字眼要標風險', () => {
    const plain = detectAliasCandidates({
      sources: [],
      productNames: ['SHARP iBarista 智慧咖啡機', 'iBarista 智慧咖啡機'],
      aliasMap: emptyMap(),
    })
    expect(plain[0]!.confidence).toBe('medium')
    expect(plain[0]!.variantRisk).toBe(false)

    // W1 REGEN vs W1 REGEN ULTRA 是兩台不同機器 → 一定要標風險,不能讓人誤按合併
    const risky = detectAliasCandidates({
      sources: [],
      productNames: ['MATELASER 筋牌特務 W1 REGEN ULTRA', 'MATELASER 筋牌特務 W1 REGEN'],
      aliasMap: emptyMap(),
    })
    expect(risky[0]!.variantRisk).toBe(true)
    expect(risky[0]!.reason).toContain('不同型號')
  })

  it('已否決的組合不再列出', () => {
    const map = emptyMap()
    map.dismissedPairs = [aliasPairKey('SHARP iBarista 智慧咖啡機', 'iBarista 智慧咖啡機')]
    const out = detectAliasCandidates({
      sources: [],
      productNames: ['SHARP iBarista 智慧咖啡機', 'iBarista 智慧咖啡機'],
      aliasMap: map,
    })
    expect(out).toHaveLength(0)
  })

  it('已確認過(兩者已指向同一正式名)不再列出', () => {
    const map = emptyMap()
    map.aliases[normalizeProductName('iBarista 智慧咖啡機')] = 'SHARP iBarista 智慧咖啡機'
    const out = detectAliasCandidates({
      sources: [],
      productNames: ['SHARP iBarista 智慧咖啡機', 'iBarista 智慧咖啡機'],
      aliasMap: map,
    })
    expect(out).toHaveLength(0)
  })

  it('太短的共同片段不算(避免「燈」這種字誤配)', () => {
    const out = detectAliasCandidates({
      sources: [],
      productNames: ['兩全奇美燈', '檯燈'],
      aliasMap: emptyMap(),
    })
    expect(out).toHaveLength(0)
  })

  it('高信心排在中信心前面', () => {
    const out = detectAliasCandidates({
      sources: [{ name: 'A牌吹風機｜B牌 專業吹風機 HD-100-說明書.pdf' }],
      productNames: ['SHARP iBarista 智慧咖啡機', 'iBarista 智慧咖啡機'],
      aliasMap: emptyMap(),
    })
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out[0]!.confidence).toBe('high')
  })
})

describe('canonicalProductName', () => {
  const aliases = { [normalizeProductName('上好ㄟ抽取式除濕機')]: 'NWT 威技 新一級能效 16L 高效抽取型除濕機' }

  it('別名換成正式名(忽略空白與大小寫差異)', () => {
    expect(canonicalProductName('上好ㄟ抽取式除濕機', aliases)).toBe('NWT 威技 新一級能效 16L 高效抽取型除濕機')
    expect(canonicalProductName('  上好ㄟ 抽取式除濕機 ', aliases)).toBe('NWT 威技 新一級能效 16L 高效抽取型除濕機')
  })

  it('沒有對照就原樣回傳;空值回空字串', () => {
    expect(canonicalProductName('BOYA mini2', aliases)).toBe('BOYA mini2')
    expect(canonicalProductName('', aliases)).toBe('')
    expect(canonicalProductName(undefined, aliases)).toBe('')
  })

  it('連鎖合併要一路解析到最終正式名(A→B、B→C 時 A 不能停在 B)', () => {
    const chained = {
      [normalizeProductName('上好ㄟ除濕機')]: '威技除濕機',
      [normalizeProductName('威技除濕機')]: 'NWT 威技 新一級能效 16L 除濕機',
    }
    expect(canonicalProductName('上好ㄟ除濕機', chained)).toBe('NWT 威技 新一級能效 16L 除濕機')
    expect(canonicalProductName('威技除濕機', chained)).toBe('NWT 威技 新一級能效 16L 除濕機')
  })

  it('對照成環時不會無限迴圈', () => {
    const cyclic = {
      [normalizeProductName('A 產品')]: 'B 產品',
      [normalizeProductName('B 產品')]: 'A 產品',
    }
    expect(() => canonicalProductName('A 產品', cyclic)).not.toThrow()
  })
})
