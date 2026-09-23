import { describe, expect, it } from 'vitest'
import {
  broadcastBelongsTo,
  buildFestivalOutcomes,
  buildOneOutcome,
  OUTCOME_MAX,
  OUTCOME_WINDOW_DAYS,
  outcomeHeadline,
  type BroadcastOutcome,
} from './festival-outcome'

const DAY = 86_400_000
const ms = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))

/** 數字抄自 MYFEEL 正式資料（2026-09-23 唯讀盤點） */
function bc(over: Partial<BroadcastOutcome> = {}): BroadcastOutcome {
  return { id: 'b1', name: '乾淨方MAX開賣', atMs: ms('2026-08-25'), sentCount: 846, clickCount: 184, ...over }
}

const GHOST = { id: 'ghost-2026', name: '中元節', date: '2026-08-27' }
const MIDAUTUMN = { id: 'midautumn-2026', name: '中秋節', date: '2026-09-25' }

describe('broadcastBelongsTo', () => {
  it('前後兩週內算這一檔', () => {
    expect(broadcastBelongsTo(bc({ atMs: ms('2026-08-27') }), GHOST.date)).toBe(true)
    expect(broadcastBelongsTo(bc({ atMs: ms('2026-08-27') - OUTCOME_WINDOW_DAYS * DAY }), GHOST.date)).toBe(true)
  })

  it('窗外的不算', () => {
    expect(broadcastBelongsTo(bc({ atMs: ms('2026-08-27') - 15 * DAY }), GHOST.date)).toBe(false)
  })

  it('時間壞掉的不猜，一律不算', () => {
    expect(broadcastBelongsTo(bc({ atMs: Number.NaN }), GHOST.date)).toBe(false)
    expect(broadcastBelongsTo(bc(), 'not-a-date')).toBe(false)
  })
})

describe('buildOneOutcome', () => {
  it('講得出發了什麼、送到幾人、被點幾次', () => {
    const o = buildOneOutcome(GHOST, [bc()], null)
    expect(o.sentTotal).toBe(846)
    expect(o.clickTotal).toBe(184)
    expect(o.text).toContain('乾淨方MAX開賣')
    expect(o.text).toContain('846 人')
    expect(o.text).toContain('184 次')
  })

  it('⛔ 口徑紅線：點擊一律講「次」，不准出現「點擊率」「幾成的人點了」', () => {
    const o = buildOneOutcome(GHOST, [bc()], null)
    expect(o.text).toContain('被點了 184 次')
    expect(o.text).toContain('每 100 人收到被點')
    for (const bad of ['點擊率', 'CTR', '成的人', '% 的人']) {
      expect(o.text).not.toContain(bad)
    }
  })

  it('每 100 人被點幾次算得對（184/846）', () => {
    expect(buildOneOutcome(GHOST, [bc()], null).clicksPer100).toBe(21.7)
  })

  it('⛔ 沒發推播要講「你沒發」，不可以整檔消失', () => {
    const o = buildOneOutcome(GHOST, [], null)
    expect(o.text).toContain('你沒有發推播')
    expect(o.clicksPer100).toBeNull()
  })

  it('⛔ 建了沒送出去的要講出來（排程失敗那種）', () => {
    const o = buildOneOutcome(GHOST, [bc({ sentCount: 0, clickCount: 0 })], null)
    expect(o.broadcasts).toEqual([])
    expect(o.text).toContain('1 則建了但一個人都沒送出去')
  })

  it('有送出、也有送 0 人的，兩件事都要講', () => {
    const o = buildOneOutcome(GHOST, [bc(), bc({ id: 'b2', sentCount: 0, clickCount: 0 })], null)
    expect(o.sentTotal).toBe(846)
    expect(o.text).toContain('另有 1 則建了沒送出去')
  })

  it('⚠️ 一次都沒被點時要講「可能本來就沒放連結」，不要讓人以為推播失敗', () => {
    const o = buildOneOutcome(GHOST, [bc({ clickCount: 0 })], null)
    expect(o.text).toContain('一次都沒有被點')
    expect(o.text).toContain('沒有放連結')
  })

  it('多則推播會合起來算', () => {
    const o = buildOneOutcome(GHOST, [bc(), bc({ id: 'b2', name: '第二則', sentCount: 154, clickCount: 46 })], null)
    expect(o.sentTotal).toBe(1000)
    expect(o.clickTotal).toBe(230)
    expect(o.text).toContain('發了 2 則推播')
  })
})

describe('跟上一檔比（⛔ 兩邊都要「真的綁在那一檔上」才比）', () => {
  // 綁定版：兩邊都帶 festivalId
  const prevLinked = buildOneOutcome(GHOST, [bc({ festivalId: GHOST.id })], null) // 21.7 次／百人
  const atMidAutumn = (over: Partial<BroadcastOutcome>) =>
    bc({ atMs: ms('2026-09-25'), festivalId: MIDAUTUMN.id, ...over })

  it('比得出來就講差多少', () => {
    const better = buildOneOutcome(MIDAUTUMN, [atMidAutumn({ sentCount: 100, clickCount: 30 })], prevLinked)
    expect(better.text).toContain('比「中元節」那一檔多 8.3 次／百人')
    const worse = buildOneOutcome(MIDAUTUMN, [atMidAutumn({ sentCount: 100, clickCount: 10 })], prevLinked)
    expect(worse.text).toContain('少 11.7 次／百人')
  })

  it('⛔ 這一檔沒資料就不比（不要生出「成長 100%」）', () => {
    expect(buildOneOutcome(MIDAUTUMN, [], prevLinked).text).not.toContain('比「中元節」')
  })

  it('⛔ 上一檔沒資料也不比', () => {
    const o = buildOneOutcome(MIDAUTUMN, [atMidAutumn({ sentCount: 100, clickCount: 30 })], null)
    expect(o.text).toContain('送到 100 人') // 先確認這一檔真的有量到，否則下面那條是假綠燈
    expect(o.text).not.toContain('比「')
  })

  // ⚠️ 2026-09-23 真資料抓到的：中元節前後兩週有 8 則推播、3,025 人，
  //    但那 8 則全是乾淨方MAX／AROMIC／KIESLECT 的商品檔期，跟中元節無關。
  it('⛔ 只是日期相近的兩批，不可以拿來比「哪一檔做得好」', () => {
    const prevGuessed = buildOneOutcome(GHOST, [bc()], null) // 沒有 festivalId
    expect(prevGuessed.linked).toBe(false)
    const now = buildOneOutcome(MIDAUTUMN, [bc({ atMs: ms('2026-09-25'), sentCount: 100, clickCount: 30 })], prevGuessed)
    expect(now.text).not.toContain('比「')
  })
})

describe('⭐ 知道 vs 猜：真資料上會把八則商品推播算成「中元節檔期」', () => {
  it('⛔ 沒有綁定時，話要講成「那段期間」而且要講出是照日期抓的', () => {
    const o = buildOneOutcome(GHOST, [bc(), bc({ id: 'b2', name: 'AROMIC上市', sentCount: 204, clickCount: 53 })], null)
    expect(o.linked).toBe(false)
    expect(o.text).toContain('前後兩週')
    expect(o.text).toContain('不一定是為了這一檔發的')
    expect(o.text).toContain('照日期抓的')
    // ⛔ 不可以講成「這一檔」的成績
    expect(o.text).not.toContain('「中元節」發了')
  })

  it('有綁定時就講得肯定，而且不再加那句警語', () => {
    const o = buildOneOutcome(GHOST, [bc({ festivalId: GHOST.id })], null)
    expect(o.linked).toBe(true)
    expect(o.text).toContain('「中元節」發了')
    expect(o.text).not.toContain('不一定是為了這一檔')
  })

  it('⭐ 有綁定的就只算綁定的，⛔ 不把日期相近的混進來灌大數字', () => {
    const o = buildOneOutcome(GHOST, [
      bc({ id: 'real', name: '中元節推播', sentCount: 100, clickCount: 20, festivalId: GHOST.id }),
      bc({ id: 'noise', name: '乾淨方MAX開賣', sentCount: 846, clickCount: 184 }),
    ], null)
    expect(o.sentTotal).toBe(100)
    expect(o.broadcasts.map(b => b.id)).toEqual(['real'])
  })

  it('⛔ 綁在別檔的推播不會被這一檔撿走', () => {
    const o = buildOneOutcome(GHOST, [bc({ festivalId: 'midautumn-2026' })], null)
    expect(o.sentTotal).toBe(0)
    expect(o.text).toContain('你沒有發推播')
  })
})

describe('buildFestivalOutcomes', () => {
  const FESTIVALS = [
    { id: 'dragon-2026', name: '端午節', date: '2026-06-19' },
    GHOST,
    MIDAUTUMN,
    { id: 'nationalday-2026', name: '國慶日', date: '2026-10-10' },
  ]

  it('只看過去的、而且在回看窗內', () => {
    const out = buildFestivalOutcomes('2026-09-26', FESTIVALS, [bc()])
    const ids = out.map(o => o.festivalId)
    expect(ids).toContain('midautumn-2026')
    expect(ids).toContain('ghost-2026')
    expect(ids).not.toContain('nationalday-2026') // 還沒到
    expect(ids).not.toContain('dragon-2026') // 超過 90 天
  })

  it('由近到遠，最多三檔', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `f${i}`, name: `節${i}`, date: `2026-0${7 + Math.floor(i / 3)}-${String(1 + (i % 3) * 10).padStart(2, '0')}`,
    }))
    const out = buildFestivalOutcomes('2026-09-26', many, [])
    expect(out.length).toBeLessThanOrEqual(OUTCOME_MAX)
    expect(out[0]!.date > out[1]!.date).toBe(true)
  })

  it('⭐ 比較基準只取「真的綁定且有送出」的那一檔，空檔期不會把基準洗掉', () => {
    // 中元節有送、中秋節沒送、國慶（假設已過）有送 → 國慶要跟中元比
    const festivals = [GHOST, MIDAUTUMN, { id: 'x-2026', name: '國慶日', date: '2026-10-10' }]
    const out = buildFestivalOutcomes('2026-10-20', festivals, [
      bc({ atMs: ms('2026-08-27'), festivalId: GHOST.id }),
      bc({ id: 'b3', name: '國慶推播', atMs: ms('2026-10-10'), sentCount: 100, clickCount: 30, festivalId: 'x-2026' }),
    ])
    const nat = out.find(o => o.festivalId === 'x-2026')!
    expect(nat.text).toContain('比「中元節」')
  })

  it('日期壞掉不會炸', () => {
    expect(buildFestivalOutcomes('壞掉', FESTIVALS, [])).toEqual([])
    expect(buildFestivalOutcomes('2026-09-26', [{ id: 'x', name: 'x', date: '' }], [])).toEqual([])
  })
})

describe('outcomeHeadline', () => {
  it('⛔ 一檔都沒有就整段不出現', () => {
    expect(outcomeHeadline([])).toBe('')
  })

  it('全都沒發時講的是另一句', () => {
    const out = buildFestivalOutcomes('2026-09-26', [GHOST, MIDAUTUMN], [])
    expect(outcomeHeadline(out)).toContain('都沒有發推播')
  })

  it('有綁定的才敢講「結果」', () => {
    const out = buildFestivalOutcomes('2026-09-26', [GHOST, MIDAUTUMN], [bc({ festivalId: GHOST.id })])
    expect(outcomeHeadline(out)).toContain('的結果')
  })

  it('⛔ 全靠日期猜的時候，標題也不可以講成「結果」', () => {
    const out = buildFestivalOutcomes('2026-09-26', [GHOST, MIDAUTUMN], [bc()])
    const h = outcomeHeadline(out)
    expect(h).toContain('前後你發過什麼')
    expect(h).not.toContain('的結果')
  })
})
