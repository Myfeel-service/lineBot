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

  it('節日表沒有去年那一檔就回 null', () => {
    expect(findLastYearFestivalBroadcast(festivals[0]!, festivals, [bc({ festivalId: 'x' })])).toBeNull()
  })
})
