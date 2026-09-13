/**
 * 標籤名「像不像」第一層（`C-178`）。
 *
 * 釘住的行為：①真的抓到那組麥克風 ②「在看」「問過」這種口頭禪不算訊號
 * ③口頭禪是**算出來**的不是寫死的（換一家店的命名習慣照樣成立）
 * ④標籤太少時不做口頭禪判斷（寧可多報，不可整層靜靜失效）⑤每組只報一次。
 *
 * 語料＝MYFEEL 正式帳號 2026-09-11 的標籤名（老闆截圖那批）。
 */
import { describe, expect, it } from 'vitest'
import {
  findSimilarNames,
  findSimilarPairs,
  genericFragments,
  normalizeTagName,
} from './tag-similarity'

/** 線上真實標籤名：這一層的門檻就是照這批資料調的 */
const LIVE_NAMES = [
  '在看香氛助眠',
  '在看紓壓按摩',
  '在看咖啡機',
  '在看 AI 錄音耳機',
  '在看料理鍋具',
  '在看收音麥克風',
  '問過發票',
  '在等開賣',
  '抱怨過',
  '問過價格優惠',
  '回報過商品故障',
  '退換貨處理中',
  '問過出貨進度',
]

const asTags = (names: string[]) => names.map((name, i) => ({ id: `t${i}`, name }))

describe('口頭禪片段（算出來的，不是寫死的停用詞表）', () => {
  it('「在看」「問過」出現在夠多顆標籤上 → 不算相似訊號', () => {
    const generic = genericFragments(LIVE_NAMES)
    expect(generic.has('在看')).toBe(true) // 6 顆
    expect(generic.has('問過')).toBe(true) // 3 顆
  })

  it('「麥克風」只出現在一顆 → 留著當訊號', () => {
    const generic = genericFragments(LIVE_NAMES)
    expect(generic.has('麥克風')).toBe(false)
  })

  /**
   * ⛔ 這條是多租戶的命脈（`feedback_saas_no_tenant_hardcoding`）：
   * 換一家店、換一套命名習慣，口頭禪要跟著換。寫死「在看／問過」只有 MYFEEL 一家準。
   */
  it('換一家店的命名習慣，口頭禪跟著換', () => {
    const other = ['想買除濕機', '想買咖啡機', '想買電風扇', '問運費', '退訂過']
    const generic = genericFragments(other)
    expect(generic.has('想買')).toBe(true)
    expect(generic.has('在看')).toBe(false) // 這家店根本不用這個詞
  })

  /** ⛔ 標籤太少時整層會靜靜失效（幾乎所有片段都被判口頭禪）→ 乾脆不判 */
  it('標籤少於門檻就不判口頭禪', () => {
    expect(genericFragments(['在看A', '在看B', '在看C']).size).toBe(0)
  })
})

describe('AI 提的新標籤 vs 既有標籤', () => {
  const tags = asTags(LIVE_NAMES)

  it('「在看無線麥克風」抓到既有的「在看收音麥克風」，理由是「麥克風」', () => {
    const hits = findSimilarNames('在看無線麥克風', tags, { corpus: LIVE_NAMES })
    expect(hits[0]?.name).toBe('在看收音麥克風')
    expect(hits[0]?.shared).toBe('麥克風')
    expect(hits[0]?.exact).toBe(false)
  })

  /**
   * ⛔ 這條是「不誤報」的守門：兩個都是「在看 X」，但 X 完全不同。
   * 只靠共用前綴就報的話，這家店每一顆標籤都會跟其他每一顆互報一次＝人第三次就不看了。
   */
  it('「在看電子鍋」「在看除濕機」不會因為都叫「在看」就被報', () => {
    expect(findSimilarNames('在看電子鍋', tags, { corpus: LIVE_NAMES })).toEqual([])
    expect(findSimilarNames('在看除濕機', tags, { corpus: LIVE_NAMES })).toEqual([])
  })

  /**
   * 「在看錄音麥克風」會同時撞到「收音麥克風」（麥克風）與「AI 錄音耳機」（錄音）。
   * 後者其實是不同品類——**這一層本來就不負責判對錯**，它只負責挑候選，
   * 誰真的是同一件事由第二層（LLM 判官）決定。最像的要排最前面。
   */
  it('一次撞到兩顆時，共用的字愈長排愈前面', () => {
    const hits = findSimilarNames('在看錄音麥克風', tags, { corpus: LIVE_NAMES })
    expect(hits.map(h => h.name)).toEqual(['在看收音麥克風', '在看 AI 錄音耳機'])
    /**
     * ⛔ 共用片段是「錄**音麥克風**」對「收**音麥克風**」＝四個字，不是「麥克風」。
     * 這正是為什麼 `shared` **不直接印給人看**：它從詞的中間切開，
     * 「兩顆都有『音麥克風』」讀起來像壞掉。畫面上的理由改由 LLM 判官用白話寫
     * （「兩顆都是麥克風，只是收音方式不同」），這個欄位只拿來排序與查問題。
     */
    expect(hits.map(h => h.shared)).toEqual(['音麥克風', '錄音'])
  })

  it('完全同名排最前面，並標成 exact（文案要講「已經有同名的」）', () => {
    const hits = findSimilarNames('在看　收音麥克風。', tags, { corpus: LIVE_NAMES })
    expect(hits[0]?.exact).toBe(true)
    expect(hits[0]?.name).toBe('在看收音麥克風') // ⛔ 印原樣，不是正規化後的
  })

  it('空名字不報（別讓還沒打完的輸入框一直閃提示）', () => {
    expect(findSimilarNames('  ', tags, { corpus: LIVE_NAMES })).toEqual([])
  })
})

describe('現有標籤兩兩對照（「檢查現有標籤」按鈕）', () => {
  it('同一組只報一次，不會 A-B 又 B-A', () => {
    const pairs = findSimilarPairs(asTags([...LIVE_NAMES, '在看無線麥克風']))
    expect(pairs).toHaveLength(1)
    expect([pairs[0]?.a.name, pairs[0]?.b.name].sort()).toEqual(
      ['在看收音麥克風', '在看無線麥克風'].sort(),
    )
    expect(pairs[0]?.shared).toBe('麥克風')
  })

  it('線上這批現有標籤本身沒有重複（不無中生有）', () => {
    expect(findSimilarPairs(asTags(LIVE_NAMES))).toEqual([])
  })
})

describe('正規化', () => {
  it('空白與標點不影響比對（沿用原本的口徑）', () => {
    expect(normalizeTagName('在看 除濕機')).toBe(normalizeTagName('在看除濕機'))
    expect(normalizeTagName('VIP Zone')).toBe(normalizeTagName('vipzone'))
  })
})
