import { describe, expect, it } from 'vitest'
import {
  AUDIENCE_MAX,
  audienceNoticeText,
  matchAudienceTags,
  productKeywords,
  type AudienceTagLike,
} from './festival-audience'

/**
 * 這一批的名字全部抄自 MYFEEL 正式資料（2026-09-23 唯讀盤點）。
 * ⛔ 不要換成「標籤A」「標籤B」——舊規則就是在漂亮的假資料上看起來會動、
 *    一碰到真名字九個節日有八個挑不到。
 */
const REAL: AudienceTagLike[] = [
  { id: 'i1', name: '在看咖啡機', aiMode: 'suggest' },
  { id: 'i2', name: '在看香氛助眠', aiMode: 'suggest' },
  { id: 'i3', name: '在看紓壓按摩', aiMode: 'suggest' },
  { id: 'i4', name: '在等開賣', aiMode: 'auto' },
  { id: 'e1', name: '客服 - SHARP 頂級A咖｜iBarista 智慧咖啡機' },
  { id: 'e2', name: '客服 - 威技 16L「上好ㄟ抽取式除濕機」' },
  { id: 'e3', name: '問卷 - AROMIC睡眠香氛機' },
  { id: 'e4', name: '問過價格優惠' },
  { id: 'x1', name: '60 天沒互動', aiMode: 'auto' },
]

const COUNTS: Record<string, number> = {
  i1: 12, i2: 8, i3: 0, i4: 30, e1: 75, e2: 47, e3: 206, e4: 40, x1: 2000,
}

function run(products: string[], festivalName = '中秋節', tags = REAL) {
  return matchAudienceTags(tags, COUNTS, { festivalName, products, excludeTagIds: ['x1'] })
}

describe('productKeywords', () => {
  it('拆得開、去得掉價格帶', () => {
    expect(productKeywords('咖啡機、除濕機、香氛機｜NT$1,200–8,900')).toEqual(['咖啡機', '除濕機', '香氛機'])
  })

  it('⛔ 一個字的不要（「鍋」「機」會把半個標籤清單掃進來）', () => {
    expect(productKeywords('機、鍋、咖啡機')).toEqual(['咖啡機'])
  })

  it('去掉修飾尾巴，「除濕機系列」對得上「除濕機」', () => {
    expect(productKeywords('除濕機系列、按摩類')).toEqual(['除濕機', '按摩'])
  })

  it('空的就是空的，不硬掰', () => {
    expect(productKeywords('')).toEqual([])
    expect(productKeywords('｜NT$100–200')).toEqual([])
  })
})

describe('matchAudienceTags', () => {
  it('⭐ 意圖型 × 商品對得上排第一，而且講得出為什麼', () => {
    const r = run(['咖啡機'])
    expect(r.suggestions[0]!.name).toBe('在看咖啡機')
    expect(r.suggestions[0]!.kind).toBe('intent_product')
    expect(r.suggestions[0]!.reason).toContain('想要')
  })

  it('⛔ 事件型要講不一樣的話：碰過 ≠ 想買（`D-28` 那條鐵律）', () => {
    const r = run(['咖啡機'])
    const ev = r.suggestions.find(s => s.kind === 'event_product')!
    expect(ev.name).toContain('iBarista')
    expect(ev.reason).toContain('不等於想買')
    // 意圖型那句⛔不可以也掛這個警語，否則兩種標籤又變成同一句話
    expect(r.suggestions[0]!.reason).not.toContain('不等於想買')
  })

  it('⛔ 意圖一定排在事件前面，就算事件那顆人多很多', () => {
    const r = run(['咖啡機'])
    // 在看咖啡機只有 12 位、iBarista 有 75 位，順序仍然是意圖在前
    expect(r.suggestions.map(s => s.kind)).toEqual(['intent_product', 'event_product'])
  })

  it('⛔ 0 位的不挑（挑了等於發給沒有人）', () => {
    const r = run(['紓壓按摩'])
    expect(r.suggestions.find(s => s.tagId === 'i3')).toBeUndefined()
  })

  it('⛔「N 天沒互動」要被排除掉（量大又跟想不想買無關）', () => {
    const r = run(['互動'])
    expect(r.suggestions.find(s => s.tagId === 'x1')).toBeUndefined()
  })

  it(`最多 ${AUDIENCE_MAX} 顆`, () => {
    const r = run(['咖啡機', '除濕機', '香氛機', '價格優惠'])
    expect(r.suggestions.length).toBeLessThanOrEqual(AUDIENCE_MAX)
  })

  it('同一顆不會重複出現（三個順位都掃過同一批）', () => {
    const r = run(['價格優惠'], '雙 11')
    expect(new Set(r.suggestions.map(s => s.tagId)).size).toBe(r.suggestions.length)
  })

  it('節慶場合字仍然有效（真的有「送禮名單」的店），但排在商品後面', () => {
    const tags = [...REAL, { id: 'g1', name: '送禮名單' }]
    const counts = { ...COUNTS, g1: 50 }
    const r = matchAudienceTags(tags, counts, { festivalName: '中秋節', products: ['咖啡機'], excludeTagIds: ['x1'] })
    const gift = r.suggestions.find(s => s.tagId === 'g1')
    // 商品有對到時，送禮那顆排在後面（甚至被 AUDIENCE_MAX 擠掉）——這是對的
    expect(r.suggestions[0]!.kind).toBe('intent_product')
    if (gift) expect(gift.kind).toBe('occasion_word')
  })

  it('沒有商品可比時，送禮標籤仍撿得到', () => {
    const tags = [{ id: 'g1', name: '送禮名單' }]
    const r = matchAudienceTags(tags, { g1: 50 }, { festivalName: '中秋節', products: [], excludeTagIds: [] })
    expect(r.suggestions[0]!.kind).toBe('occasion_word')
  })
})

describe('挑不到的時候（鐵律③：要說得出找過了、為什麼沒有）', () => {
  it('⛔ 不可以只回空陣列裝沒事', () => {
    const r = run(['完全對不上的東西'])
    expect(r.suggestions).toEqual([])
    expect(r.noMatchReason).not.toBe('')
    expect(r.scanned).toBeGreaterThan(0)
  })

  it('三種挑不到講三句不同的話', () => {
    const noTags = matchAudienceTags([], {}, { festivalName: '中秋節', products: ['咖啡機'] })
    const noProducts = run([])
    const noHit = run(['完全對不上的東西'])
    const texts = [noTags.noMatchReason, noProducts.noMatchReason, noHit.noMatchReason]
    expect(new Set(texts).size).toBe(3)
    expect(noTags.noMatchReason).toContain('還沒有任何')
    expect(noProducts.noMatchReason).toContain('沒寫主打商品')
    expect(noHit.noMatchReason).toContain('找過你')
  })

  // ⚠️ 這一組是 2026-09-23 拿 MYFEEL 真資料跑出來才補的：他有 13 顆意圖標籤，
  //    但輪廓的「主打商品」是空的 → 一顆都配不起來。那時候只回「挑不到」太廢了。
  describe('⭐ 配不起來時，把「講過自己想要什麼」的那幾群端出來當候選', () => {
    it('挑不到就給候選，而且照人數排', () => {
      const r = run(['完全對不上的東西'])
      expect(r.suggestions).toEqual([])
      expect(r.candidates.length).toBeGreaterThan(0)
      expect(r.candidates[0]!.name).toBe('在等開賣') // 30 位，想買類裡最多
      // ⛔ 0 位的（在看紓壓按摩）不可以混進候選
      expect(r.candidates.find(c => c.users === 0)).toBeUndefined()
    })

    // ⚠️ 真資料上的教訓：MYFEEL 人數最多的意圖標籤是「問過出貨進度」（59 位）。
    //    照人數排的話，中秋節檔期的第一個候選會是一群在等包裹的人。
    it('⭐「想買」排在「售後」前面，就算售後那顆人多很多', () => {
      const tags = [...REAL, { id: 's1', name: '問過出貨進度', aiMode: 'suggest' }]
      const counts = { ...COUNTS, s1: 59 }
      const r = matchAudienceTags(tags, counts, { festivalName: '中秋節', products: ['對不上'], excludeTagIds: ['x1'] })
      expect(r.candidates[0]!.name).not.toBe('問過出貨進度')
      expect(r.candidates[0]!.name).toBe('在等開賣')
    })

    it('⛔ 候選那句只敢講「AI 判出來的」，不敢講「他想要」（售後標籤也在裡面）', () => {
      const r = run(['完全對不上的東西'])
      expect(r.candidates[0]!.reason).toContain('AI 從對話判出來')
      expect(r.candidates[0]!.reason).not.toContain('想要')
    })

    it('⛔ 候選不可以自動選進受眾——替他決定發給誰就是替他決定生意', () => {
      const r = run(['完全對不上的東西'])
      // suggestions 才是會被自動選進去的那一批
      expect(r.suggestions).toEqual([])
      expect(r.candidates.length).toBeGreaterThan(0)
    })

    it('挑得到的時候不給候選（會變成兩份受眾建議互相打架）', () => {
      const r = run(['咖啡機'])
      expect(r.suggestions.length).toBeGreaterThan(0)
      expect(r.candidates).toEqual([])
    })

    it('候選要進到那句話裡，而且列兩顆不是一顆', () => {
      const r = run(['完全對不上的東西'])
      expect(r.noMatchReason).toContain(r.candidates[0]!.name)
      expect(r.noMatchReason).toContain(String(r.candidates[0]!.users))
      // ⛔ 只列一顆時，剛好排到售後那顆就整個建議都廢了
      if (r.candidates[1]) expect(r.noMatchReason).toContain(r.candidates[1].name)
    })

    it('連候選都沒有時，講的是另一句（不要硬掰一個「可以自己挑的有」）', () => {
      const onlyEvents = REAL.filter(t => !t.aiMode)
      const r = matchAudienceTags(onlyEvents, COUNTS, { festivalName: '中秋節', products: ['對不上'] })
      expect(r.candidates).toEqual([])
      expect(r.noMatchReason).toContain('自己挑')
      expect(r.noMatchReason).not.toContain('可以自己挑的有')
    })
  })

  it('「找過了」要有數字撐，不是空話', () => {
    const r = run(['完全對不上的東西'])
    expect(r.noMatchReason).toContain(String(r.scanned))
  })
})

describe('audienceNoticeText', () => {
  it('挑得到就講第一顆憑什麼', () => {
    const t = audienceNoticeText(run(['咖啡機']))
    expect(t).toContain('在看咖啡機')
    expect(t).toContain('想要')
  })

  it('挑不到就直接講原因（⛔ 不要再說一次「選了 0 個標籤」）', () => {
    const r = run(['完全對不上的東西'])
    expect(audienceNoticeText(r)).toBe(r.noMatchReason)
    expect(audienceNoticeText(r)).not.toContain('0 個')
  })
})

describe('⭐ 對照組：舊規則在真名字上幾乎全滅，新規則救得回來', () => {
  const OLD = (festivalName: string) => REAL.filter(t =>
    t.name.includes(festivalName)
    || (/春節|中秋|除夕|聖誕|情人|母親節|父親節/.test(festivalName) && /送禮|禮盒|贈禮/.test(t.name))
    || (/雙 ?11|購物節/.test(festivalName) && /回購|囤貨|揪團|優惠/.test(t.name)))

  it('舊規則：中秋節在這批真標籤上一顆都挑不到', () => {
    expect(OLD('中秋節')).toEqual([])
  })

  it('新規則：同一批標籤、同一個節日，挑得到而且講得出為什麼', () => {
    const r = run(['咖啡機', '香氛機'], '中秋節')
    expect(r.suggestions.length).toBeGreaterThan(0)
    expect(r.suggestions.every(s => s.reason.length > 0)).toBe(true)
  })
})
