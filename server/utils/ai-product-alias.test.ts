import { describe, it, expect } from 'vitest'
import {
  canonicalProductName,
  confirmAlias,
  dedupeProductNames,
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

  it('訊號3:字幾乎一樣(可能打錯字)→ 中信心;被較多資料使用的當正式名', () => {
    const out = detectAliasCandidates({
      // 正確寫法掛兩份資料、錯字只掛一份 → 正確寫法當正式名
      sources: [
        { productName: 'GPLUS 智慧除濕機 12L' },
        { productName: 'GPLUS 智慧除濕機 12L' },
        { productName: 'GPLSU 智慧除濕機 12L' },
      ],
      productNames: ['GPLUS 智慧除濕機 12L', 'GPLSU 智慧除濕機 12L'],
      aliasMap: emptyMap(),
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.confidence).toBe('medium')
    expect(out[0]!.variantRisk).toBe(false)
    expect(out[0]!.a).toBe('GPLUS 智慧除濕機 12L')
    expect(out[0]!.b).toBe('GPLSU 智慧除濕機 12L')
    expect(out[0]!.reason).toContain('打錯字')
  })

  it('訊號3:數字不同(12L vs 16L)不列——同系列不同型號,列出來會誘導誤併', () => {
    const out = detectAliasCandidates({
      sources: [],
      productNames: ['GPLUS 智慧除濕機 12L', 'GPLUS 智慧除濕機 16L'],
      aliasMap: emptyMap(),
    })
    expect(out).toHaveLength(0)
  })

  it('訊號3:已否決的錯字組合不再列出', () => {
    const map = emptyMap()
    map.dismissedPairs = [aliasPairKey('GPLUS 智慧除濕機 12L', 'GPLSU 智慧除濕機 12L')]
    const out = detectAliasCandidates({
      sources: [],
      productNames: ['GPLUS 智慧除濕機 12L', 'GPLSU 智慧除濕機 12L'],
      aliasMap: map,
    })
    expect(out).toHaveLength(0)
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

  it('連鎖合併過的組合不再列出(A→B、B→C 時 A 與 C 早就是同一台)', () => {
    // 實測災情:頂級A咖→iBarista、iBarista→SHARP iBarista 都併過了,
    // 只查一層會判定「頂級A咖(→iBarista)」與「iBarista(→SHARP iBarista)」不同 → 候選重新冒出來,
    // 使用者按合併寫入的內容與現況一模一樣 → 畫面沒變,看起來就是按了沒反應。
    const map = emptyMap()
    map.aliases[normalizeProductName('SHARP 頂級A咖')] = 'iBarista 智慧咖啡機'
    map.aliases[normalizeProductName('iBarista 智慧咖啡機')] = 'SHARP iBarista 智慧咖啡機'
    const out = detectAliasCandidates({
      sources: [{ type: 'file', name: 'SHARP 頂級A咖｜iBarista 智慧咖啡機 HM-AD20VT使用說明書.pdf' }],
      productNames: ['SHARP iBarista 智慧咖啡機', 'iBarista 智慧咖啡機', 'SHARP 頂級A咖'],
      aliasMap: map,
    })
    expect(out).toHaveLength(0)
  })

  it('正式名顯示最終那一層(a 自己是別名時,卡片寫的正式名要等於實際會寫入的)', () => {
    const map = emptyMap()
    map.aliases[normalizeProductName('iBarista 智慧咖啡機')] = 'SHARP iBarista 智慧咖啡機'
    const out = detectAliasCandidates({
      sources: [{ type: 'file', name: 'SHARP 頂級A咖｜iBarista 智慧咖啡機使用說明書.pdf' }],
      productNames: ['SHARP iBarista 智慧咖啡機', 'iBarista 智慧咖啡機', 'SHARP 頂級A咖'],
      aliasMap: map,
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.a).toBe('SHARP iBarista 智慧咖啡機')
    expect(out[0]!.b).toBe('SHARP 頂級A咖')
  })

  it('訊號1 差在型號字尾時照樣標風險(說明書常一次涵蓋基本款與 ULTRA)', () => {
    const out = detectAliasCandidates({
      sources: [{ type: 'file', name: 'MATELASER 筋牌特務 W1 REGEN｜MATELASER 筋牌特務 W1 REGEN ULTRA-說明書.pdf' }],
      productNames: [],
      aliasMap: emptyMap(),
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.variantRisk).toBe(true)
  })

  it('訊號1 對齊既有產品名時不可對齊到不同型號', () => {
    const out = detectAliasCandidates({
      sources: [{ type: 'file', name: '筋牌特務按摩槍｜MATELASER 筋牌特務 W1 REGEN-說明書.pdf' }],
      // 既有清單裡只有 ULTRA:基本款不該被「對齊」成 ULTRA
      productNames: ['MATELASER 筋牌特務 W1 REGEN ULTRA'],
      aliasMap: emptyMap(),
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.a).toBe('MATELASER 筋牌特務 W1 REGEN')
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

describe('confirmAlias', () => {
  /** 只實作 confirmAlias 用到的 doc().get()/set(merge) —— aliases 是扁平物件，淺層合併即可 */
  function fakeDb(initial: Record<string, any> = {}) {
    const doc = { ...initial }
    const writes: any[] = []
    const db = {
      collection: () => ({
        doc: () => ({
          get: async () => ({ data: () => doc }),
          set: async (data: any) => {
            writes.push(data)
            doc.aliases = { ...(doc.aliases ?? {}), ...(data.aliases ?? {}) }
            doc.aliasLabels = { ...(doc.aliasLabels ?? {}), ...(data.aliasLabels ?? {}) }
          },
        }),
      }),
    }
    return { db: db as any, doc, writes }
  }

  it('把正式名解析到最終那一層,不留 A→B→C 的鏈', async () => {
    const { db, doc } = fakeDb({
      aliases: { [normalizeProductName('iBarista 智慧咖啡機')]: 'SHARP iBarista 智慧咖啡機' },
    })
    await confirmAlias(db, 'ws1', 'iBarista 智慧咖啡機', 'SHARP 頂級A咖')
    // 指到 iBarista 就會讓「已確認的對照」出現同一個名字既在箭頭左邊又在右邊
    expect(doc.aliases[normalizeProductName('SHARP 頂級A咖')]).toBe('SHARP iBarista 智慧咖啡機')
  })

  it('原本指向 alias 的別名要一起搬過來', async () => {
    const { db, doc } = fakeDb({
      aliases: { [normalizeProductName('SHARP 頂級A咖')]: 'iBarista 智慧咖啡機' },
    })
    await confirmAlias(db, 'ws2', 'SHARP iBarista 智慧咖啡機', 'iBarista 智慧咖啡機')
    expect(doc.aliases[normalizeProductName('iBarista 智慧咖啡機')]).toBe('SHARP iBarista 智慧咖啡機')
    expect(doc.aliases[normalizeProductName('SHARP 頂級A咖')]).toBe('SHARP iBarista 智慧咖啡機')
  })

  it('早就是同一台就不寫入,回 false 讓前端說得出「本來就已經合併」', async () => {
    const { db, writes } = fakeDb({
      aliases: {
        [normalizeProductName('SHARP 頂級A咖')]: 'iBarista 智慧咖啡機',
        [normalizeProductName('iBarista 智慧咖啡機')]: 'SHARP iBarista 智慧咖啡機',
      },
    })
    expect(await confirmAlias(db, 'ws3', 'iBarista 智慧咖啡機', 'SHARP 頂級A咖')).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it('反向合併不寫入(canonical 早就併進 alias,寫下去會成環)', async () => {
    const { db, writes } = fakeDb({
      aliases: { [normalizeProductName('SHARP 頂級A咖')]: 'iBarista 智慧咖啡機' },
    })
    expect(await confirmAlias(db, 'ws4', 'SHARP 頂級A咖', 'iBarista 智慧咖啡機')).toBe(false)
    expect(writes).toHaveLength(0)
  })
})

describe('dedupeProductNames', () => {
  it('收斂只差裝飾符號的寫法,保留沒有書名號的那個', () => {
    expect(dedupeProductNames([
      'MATELASER《筋牌特務》 W1 REGEN',
      'MATELASER 筋牌特務 W1 REGEN',
    ])).toEqual(['MATELASER 筋牌特務 W1 REGEN'])
  })

  it('不同型號不合併(REGEN 與 REGEN ULTRA 是兩台機器)', () => {
    const out = dedupeProductNames([
      'MATELASER 筋牌特務 W1 REGEN',
      'MATELASER 筋牌特務 W1 REGEN ULTRA',
    ])
    expect(out).toHaveLength(2)
  })

  it('忽略空字串', () => {
    expect(dedupeProductNames(['', '  ', 'BOYA mini2'])).toEqual(['BOYA mini2'])
  })
})
