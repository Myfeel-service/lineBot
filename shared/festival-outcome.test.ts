import { describe, expect, it } from 'vitest'
import {
  broadcastFestivalMatch,
  broadcastResultText,
  buildFestivalOutcomes,
  buildOneOutcome,
  festivalNameKeywords,
  findLastYearFestivalBroadcast,
  OUTCOME_MAX,
  outcomeLineText,
  outcomeSummary,
  type BroadcastOutcome,
} from './festival-outcome'
import { TAIWAN_FESTIVALS } from './taiwan-festivals'

const DAY = 86_400_000
/** 台灣時間那天的晚上 9 點（推播多半那時候發） */
const at = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 13)

function bc(over: Partial<BroadcastOutcome> = {}): BroadcastOutcome {
  return { id: 'b1', name: '小滑手_開賣', atMs: at('2026-09-29'), sentCount: 2187, line: { opened: 785, clicked: 443 }, ...over }
}

const GHOST = { id: 'ghost-2026', name: '中元節', date: '2026-08-27' }
const MIDAUTUMN = { id: 'midautumn-2026', name: '中秋節', date: '2026-09-25' }
const NATIONAL = { id: 'nationalday-2026', name: '國慶日', date: '2026-10-10' }
const NOW = at('2026-10-11')

/**
 * 2026-10-11 唯讀盤點 MYFEEL 正式資料（`D-121`）：8/1 以後送出的 14 則全是商品上市推播，
 * 沒有一則從「為這一檔擬推播」建立，名稱裡也沒有任何節日名。
 */
const MYFEEL_REAL: BroadcastOutcome[] = [
  ['AROMIC上市', '2026-08-13', 204], ['KIESLECT預熱', '2026-08-19', 460], ['KIESLECT正式上市', '2026-08-20', 472],
  ['AROMIC超早鳥倒數', '2026-08-30', 199], ['乾淨方MAX開賣', '2026-09-01', 846], ['乾淨方MAX超早鳥倒數', '2026-09-04', 1],
  ['乾淨方MAX超早鳥倒數測試', '2026-09-04', 1], ['乾淨方MAX超早鳥倒數', '2026-09-06', 842], ['電淨艙_開賣', '2026-09-29', 1613],
  ['小滑手_開賣', '2026-09-29', 2187], ['水都會_開賣', '2026-10-01', 464], ['電淨艙_超早鳥倒數', '2026-10-04', 1592],
  ['小滑手_超早鳥倒數', '2026-10-04', 2165], ['水多會-超早鳥倒數', '2026-10-05', 461],
].map(([name, d, sent], i) => ({ id: `r${i}`, name: String(name), atMs: at(String(d)), sentCount: Number(sent) }))

describe('broadcastFestivalMatch（`D-121`①：只算為這一檔發的）', () => {
  it('從「為這一檔擬推播」建立的＝linked', () => {
    expect(broadcastFestivalMatch(bc({ festivalId: MIDAUTUMN.id }), MIDAUTUMN)).toBe('linked')
  })

  it('⛔ 綁在別檔的不會被這一檔撿走（就算名稱有這一檔的字）', () => {
    expect(broadcastFestivalMatch(bc({ name: '中秋禮盒', festivalId: NATIONAL.id }), MIDAUTUMN)).toBeNull()
  })

  it('名稱裡有節日名、時間在節日前 30 天到後 7 天內＝named', () => {
    expect(broadcastFestivalMatch(bc({ name: '中秋禮盒早鳥', atMs: at('2026-09-10') }), MIDAUTUMN)).toBe('named')
    expect(broadcastFestivalMatch(bc({ name: '雙十連假出遊', atMs: at('2026-10-05') }), NATIONAL)).toBe('named')
  })

  it('⛔ 名稱對上但時間差太遠（去年的、或兩個月前的）不算', () => {
    expect(broadcastFestivalMatch(bc({ name: '中秋禮盒', atMs: at('2025-10-01') }), MIDAUTUMN)).toBeNull()
    expect(broadcastFestivalMatch(bc({ name: '中秋禮盒', atMs: at('2026-07-20') }), MIDAUTUMN)).toBeNull()
  })

  it('⭐ 真資料：中秋與國慶前後那 6 則商品推播，兩檔都不算（以前被兩檔各算一次）', () => {
    for (const f of [GHOST, MIDAUTUMN, NATIONAL]) {
      expect(MYFEEL_REAL.filter(b => broadcastFestivalMatch(b, f) !== null), f.name).toEqual([])
    }
  })

  it('「雙 11」不管有沒有空白都認得', () => {
    const d11 = { id: 'double11-2026', name: '雙 11 購物節', date: '2026-11-11' }
    expect(broadcastFestivalMatch(bc({ name: '雙11早鳥', atMs: at('2026-11-01') }), d11)).toBe('named')
    expect(broadcastFestivalMatch(bc({ name: '雙 11 早鳥', atMs: at('2026-11-01') }), d11)).toBe('named')
  })

  it('時間壞掉的不猜，一律不算', () => {
    expect(broadcastFestivalMatch(bc({ name: '中秋', atMs: Number.NaN }), MIDAUTUMN)).toBeNull()
    expect(broadcastFestivalMatch(bc({ name: '中秋' }), { ...MIDAUTUMN, date: 'not-a-date' })).toBeNull()
  })
})

describe('festivalNameKeywords', () => {
  it('節日表裡每一個節日都有認得的字（新增節日時別忘了這張表）', () => {
    for (const f of TAIWAN_FESTIVALS) expect(festivalNameKeywords(f.name).length, f.name).toBeGreaterThan(0)
  })

  it('⛔ 不收會撞到別檔或平常就會用的字', () => {
    const all = TAIWAN_FESTIVALS.flatMap(f => festivalNameKeywords(f.name))
    for (const bad of ['新年', '媽媽', '情人', '節']) expect(all).not.toContain(bad)
  })
})

describe('buildOneOutcome', () => {
  it('只發給 1～2 人的當試發，不算成效但要記下來', () => {
    const o = buildOneOutcome(MIDAUTUMN, [
      bc({ id: 'real', name: '中秋禮盒', atMs: at('2026-09-20'), festivalId: MIDAUTUMN.id }),
      bc({ id: 'test', name: '中秋禮盒測試', atMs: at('2026-09-19'), sentCount: 1, festivalId: MIDAUTUMN.id }),
    ])
    expect(o.broadcasts.map(b => b.id)).toEqual(['real'])
    expect(o.testSends).toBe(1)
  })

  it('建了但沒送出去的要記下來', () => {
    const o = buildOneOutcome(MIDAUTUMN, [bc({ sentCount: 0, festivalId: MIDAUTUMN.id })])
    expect(o.broadcasts).toEqual([])
    expect(o.zeroSent).toBe(1)
  })

  it('由近到遠排', () => {
    const o = buildOneOutcome(MIDAUTUMN, [
      bc({ id: 'early', atMs: at('2026-09-10'), festivalId: MIDAUTUMN.id }),
      bc({ id: 'late', atMs: at('2026-09-22'), festivalId: MIDAUTUMN.id }),
    ])
    expect(o.broadcasts.map(b => b.id)).toEqual(['late', 'early'])
  })
})

describe('broadcastResultText（`D-121`②：LINE 的人數，⛔ 拿不到不寫 0）', () => {
  it('兩個數字都有：送幾人、幾人打開、幾人點連結', () => {
    expect(broadcastResultText(bc(), NOW)).toBe('送 2,187 人，785 人打開，443 人點連結（LINE 官方統計）')
  })

  it('⛔ 口徑紅線：一律是「人」，不出現「次」「點擊率」「每 100 人」', () => {
    const t = broadcastResultText(bc(), NOW)
    for (const bad of ['次', '點擊率', 'CTR', '每 100 人']) expect(t).not.toContain(bad)
  })

  it('人太少 LINE 不給（隱私）：講原因', () => {
    expect(broadcastResultText(bc({ line: { opened: null, clicked: null } }), NOW)).toContain('人太少，LINE 不提供數字')
    // 真資料：水多會-超早鳥倒數 74 人打開、點連結的 LINE 不給
    const t = broadcastResultText(bc({ line: { opened: 74, clicked: null } }), NOW)
    expect(t).toContain('74 人打開')
    expect(t).toContain('點連結的人太少')
    expect(t).not.toContain(' 0 人')
  })

  it('剛發完還沒存到：講「隔天才有」', () => {
    expect(broadcastResultText(bc({ atMs: NOW - DAY / 2, line: null }), NOW)).toContain('發完隔天才有')
  })

  it('發得太早、LINE 已經查不到：照實講', () => {
    expect(broadcastResultText(bc({ atMs: NOW - 40 * DAY, line: null }), NOW)).toContain('LINE 已經查不到')
  })

  it('發送時沒帶統計標記：照實講', () => {
    expect(broadcastResultText(bc({ line: { opened: null, clicked: null, unavailable: true } }), NOW)).toContain('沒帶到 LINE 的統計標記')
  })
})

describe('buildFestivalOutcomes', () => {
  const FESTIVALS = [
    { id: 'dragon-2026', name: '端午節', date: '2026-06-19' },
    GHOST,
    MIDAUTUMN,
    NATIONAL,
    { id: 'doubleninth-2026', name: '重陽節', date: '2026-10-18' },
  ]

  it('只看過去的、在回看窗內的，由近到遠、最多三檔', () => {
    const out = buildFestivalOutcomes('2026-10-11', FESTIVALS, [])
    expect(out.map(o => o.festivalId)).toEqual(['nationalday-2026', 'midautumn-2026', 'ghost-2026'])
    expect(out.length).toBeLessThanOrEqual(OUTCOME_MAX)
  })

  it('日期壞掉不會炸', () => {
    expect(buildFestivalOutcomes('壞掉', FESTIVALS, [])).toEqual([])
    expect(buildFestivalOutcomes('2026-09-26', [{ id: 'x', name: 'x', date: '' }], [])).toEqual([])
  })
})

describe('outcomeSummary（卡片最下面那一行）', () => {
  const three = (list: BroadcastOutcome[]) => buildFestivalOutcomes('2026-10-11', [GHOST, MIDAUTUMN, NATIONAL], list)
  const texts = (list: BroadcastOutcome[]) => outcomeSummary(three(list), NOW).lines.map(outcomeLineText)

  it('⭐ 真資料（今天的 MYFEEL）：一行講完三檔都沒有為節日發，並講從這裡擬的才看得到成效', () => {
    const s = outcomeSummary(three(MYFEEL_REAL), NOW)
    expect(s.label).toBe('最近 3 檔')
    expect(s.lines.map(outcomeLineText)).toEqual([
      '中元節、中秋節、國慶日都沒有為節日發的推播。從這裡擬的推播，發完會在這裡看到幾個人打開、幾個人點。',
    ])
  })

  it('⛔ 以前那三句警語與「次數不是人數」都不會再出現', () => {
    const all = texts(MYFEEL_REAL).join()
    for (const bad of ['照日期抓', '不一定是為了這一檔', '沒有放連結', '次數']) expect(all).not.toContain(bad)
  })

  it('有為節日發的：一則一行，名字是連結，不跨推播加總人數', () => {
    const s = outcomeSummary(three([
      bc({ id: 'n1', name: '國慶連假早鳥', atMs: at('2026-10-05'), sentCount: 2140, line: { opened: 612, clicked: 198 }, festivalId: NATIONAL.id }),
      bc({ id: 'n2', name: '國慶最後一天', atMs: at('2026-10-09'), sentCount: 2100, line: { opened: 500, clicked: 120 }, festivalId: NATIONAL.id }),
    ]), NOW)
    expect(s.lines[0]).toMatchObject({ before: '國慶日', broadcast: { id: 'n2', name: '國慶最後一天' } })
    expect(s.lines[1]).toMatchObject({ before: '國慶日', broadcast: { id: 'n1', name: '國慶連假早鳥' } })
    expect(outcomeLineText(s.lines[1]!)).toBe('國慶日「國慶連假早鳥」送 2,140 人，612 人打開，198 人點連結（LINE 官方統計）')
    // ⛔ 不出現加總（4,240 人／1,112 人打開）
    const all = s.lines.map(outcomeLineText).join()
    expect(all).not.toContain('4,240')
    expect(all).not.toContain('1,112')
    // 沒發的那兩檔併成一行，⛔ 不再補「從這裡擬的…」（他已經在用了）
    expect(outcomeLineText(s.lines[2]!)).toBe('中元節、中秋節沒有為節日發的推播。')
  })

  it('同一檔超過兩則：列兩則，其他講「另外 N 則」', () => {
    const list = [5, 6, 7].map(d => bc({ id: `n${d}`, name: `國慶${d}`, atMs: at(`2026-10-0${d}`), festivalId: NATIONAL.id }))
    const t = texts(list)
    expect(t.filter(x => x.startsWith('國慶日「'))).toHaveLength(2)
    expect(t.join()).toContain('另外還有 1 則')
  })

  it('試發與沒送出去的要講出來（⛔ 不靜靜吃掉）', () => {
    const t = texts([
      bc({ id: 'z', name: '國慶早鳥', atMs: at('2026-10-05'), sentCount: 0, festivalId: NATIONAL.id }),
      bc({ id: 't', name: '國慶早鳥測試', atMs: at('2026-10-04'), sentCount: 1, festivalId: NATIONAL.id }),
    ])
    expect(t[0]).toBe('國慶日有 1 則建了但一個人都沒送出去，去推播頁看看卡在哪；1 則只發給 1～2 人（試發），沒算進來。')
  })

  it('只有一檔在回看窗內時，標題叫「上一檔」', () => {
    const s = outcomeSummary(buildFestivalOutcomes('2026-10-11', [NATIONAL], []), NOW)
    expect(s.label).toBe('上一檔')
    expect(outcomeLineText(s.lines[0]!)).toBe('國慶日沒有為節日發的推播。從這裡擬的推播，發完會在這裡看到幾個人打開、幾個人點。')
  })

  it('⛔ 一檔都沒有（回看窗內沒有過去的節日）就整段不出現', () => {
    expect(outcomeSummary([], NOW)).toEqual({ label: '', lines: [] })
  })
})

describe('findLastYearFestivalBroadcast（去年這一檔為它發的）', () => {
  const festivals = [
    { id: 'midautumn-2026', name: '中秋節', date: '2026-09-25' },
    { id: 'midautumn-2027', name: '中秋節', date: '2027-09-15' },
  ]

  it('照歸屬規則找去年那一檔，好幾則取送最多人的', () => {
    const hit = findLastYearFestivalBroadcast(festivals[1]!, festivals, [
      bc({ id: 'a', name: '中秋禮盒', atMs: at('2026-09-15'), sentCount: 400 }),
      bc({ id: 'b', festivalId: 'midautumn-2026', atMs: at('2026-09-20'), sentCount: 900 }),
    ])
    expect(hit?.id).toBe('b')
  })

  it('⛔ 去年這時候的商品推播不算（以前照日期猜，會講成「去年這個時候你發過小滑手_開賣」）', () => {
    expect(findLastYearFestivalBroadcast(festivals[1]!, festivals, MYFEEL_REAL)).toBeNull()
  })

  it('節日表沒有去年那一檔、也找不到為它發的：回 null', () => {
    expect(findLastYearFestivalBroadcast(festivals[0]!, festivals, [bc({ festivalId: 'x' })])).toBeNull()
  })
})

/**
 * 審查抓到：節日表從 2026-08-27 才開始，只認表上「去年那一檔」的話，2027 年中以前的每一檔
 * 都找不到去年 → 「去年這一檔你發過…」一次都不會出現。表上沒有去年那一檔時，改看去年同一段日子。
 */
describe('findLastYearFestivalBroadcast：節日表沒有去年那一檔（表從 2026-08-27 才開始）', () => {
  it('國曆節日（聖誕節）：去年同一天前後找得到', () => {
    const xmas = TAIWAN_FESTIVALS.find(f => f.id === 'christmas-2026')!
    const hit = findLastYearFestivalBroadcast(xmas, TAIWAN_FESTIVALS, [
      bc({ id: 'x25', name: '聖誕交換禮物', atMs: at('2025-12-15'), sentCount: 800 }),
    ])
    expect(hit?.id).toBe('x25')
    // 從「為這一檔擬推播」建的（帶去年那一檔的 id）名稱沒有節日字也算
    const linked = findLastYearFestivalBroadcast(xmas, TAIWAN_FESTIVALS, [
      bc({ id: 'l25', name: '年底感謝祭', atMs: at('2025-12-20'), sentCount: 700, festivalId: 'christmas-2025' }),
    ])
    expect(linked?.id).toBe('l25')
  })

  it('農曆節日（重陽）：去年的重陽晚了 11 天（2025-10-29），照樣找得到', () => {
    const d9 = TAIWAN_FESTIVALS.find(f => f.id === 'doubleninth-2026')!
    const hit = findLastYearFestivalBroadcast(d9, TAIWAN_FESTIVALS, [
      // 去年重陽當天才發、比「去年的 10/18」晚 11 天
      bc({ id: 'd25', name: '重陽敬老禮盒', atMs: at('2025-10-29'), sentCount: 600 }),
    ])
    expect(hit?.id).toBe('d25')
  })

  it('農曆節日遇到閏月（春節）：去年的春節早了 19 天（2025-01-29 vs 2026-02-17），照樣找得到', () => {
    const cny = { id: 'lunarnewyear-2026', name: '春節（農曆新年）', date: '2026-02-17' }
    const hit = findLastYearFestivalBroadcast(cny, [cny], [
      // 去年春節前 30 天發的早鳥：離「去年的 2/17」整整 49 天
      bc({ id: 'c25', name: '春節禮盒早鳥', atMs: at('2024-12-30'), sentCount: 900 }),
    ])
    expect(hit?.id).toBe('c25')
  })

  it('⛔ 放寬的只有日期：名稱對不上、試發、綁在別檔的一樣不算；前年的也不算', () => {
    const d9 = TAIWAN_FESTIVALS.find(f => f.id === 'doubleninth-2026')!
    expect(findLastYearFestivalBroadcast(d9, TAIWAN_FESTIVALS, [
      bc({ id: 'p', name: '小滑手_開賣', atMs: at('2025-10-25'), sentCount: 2000 }),
      bc({ id: 't', name: '重陽測試', atMs: at('2025-10-25'), sentCount: 1 }),
      bc({ id: 'o', name: '重陽敬老', atMs: at('2025-10-25'), sentCount: 500, festivalId: 'christmas-2025' }),
      bc({ id: 'old', name: '重陽敬老', atMs: at('2024-10-11'), sentCount: 500 }),
    ])).toBeNull()
  })

  it('⭐ 表上每一對「今年／去年」：把去年那一檔拿掉，去年歸屬範圍的頭尾兩天照樣找得到', () => {
    for (const thisYear of TAIWAN_FESTIVALS) {
      const y = Number(thisYear.date.slice(0, 4))
      const lastYear = TAIWAN_FESTIVALS.find(f => f.name === thisYear.name && Number(f.date.slice(0, 4)) === y - 1)
      if (!lastYear) continue
      const withoutLastYear = TAIWAN_FESTIVALS.filter(f => f !== lastYear)
      const kw = festivalNameKeywords(thisYear.name)[0]!
      const center = Date.UTC(+lastYear.date.slice(0, 4), +lastYear.date.slice(5, 7) - 1, +lastYear.date.slice(8, 10))
      for (const atMs of [center - 30 * DAY, center + 7 * DAY]) {
        const hit = findLastYearFestivalBroadcast(thisYear, withoutLastYear, [bc({ id: 'ly', name: `${kw}活動`, atMs, sentCount: 300 })])
        expect(hit?.id, `${thisYear.id} ← ${lastYear.date}`).toBe('ly')
      }
    }
  })
})

/**
 * 審查抓到：國慶日的「雙十」是「雙十一」的前半段，雙十一早鳥落在國慶前後就被算成國慶的推播
 * （回顧算錯、「已經排好了」還會把國慶的「為這一檔擬推播」藏起來）。
 */
describe('節日關鍵字互相包含（審查第 2 條）', () => {
  const D11 = { id: 'double11-2026', name: '雙 11 購物節', date: '2026-11-11' }
  const VALENTINE = { id: 'valentines-2027', name: '西洋情人節', date: '2027-02-14' }

  it('「雙十一」不算國慶日，但還是雙 11 的', () => {
    const b = bc({ name: '雙十一早鳥預告', atMs: at('2026-10-15') })
    expect(broadcastFestivalMatch(b, NATIONAL)).toBeNull()
    expect(broadcastFestivalMatch({ ...b, atMs: at('2026-11-01') }, D11)).toBe('named')
  })

  it('「雙十二」也不算國慶日；真的寫「雙十」的照樣算', () => {
    expect(broadcastFestivalMatch(bc({ name: '雙十二預告', atMs: at('2026-10-15') }), NATIONAL)).toBeNull()
    expect(broadcastFestivalMatch(bc({ name: '雙十連假，雙十一先別急', atMs: at('2026-10-05') }), NATIONAL)).toBe('named')
  })

  it('「七夕情人節」「白色情人節」不算西洋情人節；只寫「情人節」的算', () => {
    expect(broadcastFestivalMatch(bc({ name: '白色情人節預購', atMs: at('2027-02-10') }), VALENTINE)).toBeNull()
    expect(broadcastFestivalMatch(bc({ name: '七夕情人節回顧', atMs: at('2027-02-10') }), VALENTINE)).toBeNull()
    expect(broadcastFestivalMatch(bc({ name: '情人節雙人套餐', atMs: at('2027-02-10') }), VALENTINE)).toBe('named')
  })

  it('⭐ 全表盤點：任何一檔的字被別檔更長的字包住時，那個長字只算別檔', () => {
    const named = new Map<string, { id: string, name: string, date: string }>()
    for (const f of TAIWAN_FESTIVALS) if (!named.has(f.name)) named.set(f.name, f)
    const list = [...named.values()]
    let pairs = 0
    for (const a of list) {
      for (const b of list) {
        if (a === b) continue
        for (const ka of festivalNameKeywords(a.name)) {
          for (const kb of festivalNameKeywords(b.name)) {
            if (kb === ka || !kb.includes(ka)) continue
            pairs++
            // 名稱就是 b 的長字、日期正好落在 a 那一檔：⛔ 不可以算給 a
            expect(broadcastFestivalMatch(bc({ name: kb, atMs: at(a.date) }), a), `${kb} → ${a.name}`).toBeNull()
          }
        }
      }
    }
    // 目前表上只有「雙十」⊂「雙十一」這一對；新增關鍵字時這條會自動把新的一對也驗進來
    expect(pairs).toBeGreaterThanOrEqual(1)
  })
})

/**
 * `D-122`②：店家自己的檔期。歸屬照現在的規則（從這一檔擬的／設成檔期的，或推播名稱裡有檔期名的），
 * ⛔ 但比的是**整個檔期名**，不是節日的關鍵字表。
 */
describe('自己的檔期的歸屬（D-122②）', () => {
  const LAUNCH = { id: 'own-launch0001', name: '小滑手開賣', date: '2026-09-29', own: true }

  it('⭐ 真資料：推播「小滑手_開賣」算進檔期「小滑手開賣」（底線、空白、橫線都不影響）', () => {
    expect(broadcastFestivalMatch(bc(), LAUNCH)).toBe('named')
    expect(broadcastFestivalMatch(bc({ name: '小滑手 - 開賣' }), LAUNCH)).toBe('named')
  })

  it('從這一檔擬的／設成檔期的＝linked；綁在別檔的不算', () => {
    expect(broadcastFestivalMatch(bc({ name: '隨便取的名字', festivalId: LAUNCH.id }), LAUNCH)).toBe('linked')
    expect(broadcastFestivalMatch(bc({ festivalId: 'midautumn-2026' }), LAUNCH)).toBeNull()
  })

  it('⛔ 不拆字：同一系列的別檔（「小滑手_超早鳥倒數」）不算進「小滑手開賣」', () => {
    expect(broadcastFestivalMatch(bc({ name: '小滑手_超早鳥倒數', atMs: at('2026-09-25') }), LAUNCH)).toBeNull()
  })

  it('⛔ 不去尾巴的「日」：「會員日」不會變成「會員」把每一則會員推播都吃進來', () => {
    const memberDay = { id: 'own-member0001', name: '會員日', date: '2026-10-20', own: true }
    expect(broadcastFestivalMatch(bc({ name: '會員專屬好禮', atMs: at('2026-10-15') }), memberDay)).toBeNull()
    expect(broadcastFestivalMatch(bc({ name: '十月會員日', atMs: at('2026-10-15') }), memberDay)).toBe('named')
  })

  it('⛔ 兩個字以下的檔期名不比名稱（「開賣」會撞到每一檔），只認綁定的', () => {
    const short = { id: 'own-short00001', name: '開賣', date: '2026-09-29', own: true }
    expect(broadcastFestivalMatch(bc(), short)).toBeNull()
    expect(broadcastFestivalMatch(bc({ festivalId: short.id }), short)).toBe('linked')
  })

  it('時間窗跟節日一樣（前 30 天到後 7 天）', () => {
    expect(broadcastFestivalMatch(bc({ atMs: at('2026-07-01') }), LAUNCH)).toBeNull()
  })

  it('回顧：自己的檔期有推播就一行講 LINE 人數（示意頁那一行）', () => {
    const s = outcomeSummary(buildFestivalOutcomes('2026-10-11', [LAUNCH], [bc()]), NOW)
    expect(s.label).toBe('上一檔')
    expect(s.lines.map(outcomeLineText)).toEqual(['小滑手開賣「小滑手_開賣」送 2,187 人，785 人打開，443 人點連結（LINE 官方統計）'])
  })

  it('回顧：沒發推播的自己的檔期，⛔ 不說「沒有為節日發」（週年慶不是節日）', () => {
    const anniversary = { id: 'own-anniv00001', name: '週年慶', date: '2026-10-01', own: true }
    const one = outcomeSummary(buildFestivalOutcomes('2026-10-11', [anniversary], []), NOW)
    expect(one.lines.map(outcomeLineText)).toEqual(['週年慶沒有為這一檔發的推播。從這裡擬的推播，發完會在這裡看到幾個人打開、幾個人點。'])
    const mixed = outcomeSummary(buildFestivalOutcomes('2026-10-11', [MIDAUTUMN, anniversary, NATIONAL], []), NOW)
    expect(mixed.lines.map(outcomeLineText)).toEqual(['中秋節、週年慶、國慶日都沒有為這幾檔發的推播。從這裡擬的推播，發完會在這裡看到幾個人打開、幾個人點。'])
    // 對照組：全是節日時一字不改
    expect(outcomeSummary(buildFestivalOutcomes('2026-10-11', [MIDAUTUMN, NATIONAL], []), NOW).lines.map(outcomeLineText)[0])
      .toContain('都沒有為節日發的推播')
  })
})
