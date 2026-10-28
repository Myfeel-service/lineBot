/**
 * 好友統計事實層（`D-155`）的測試。
 *
 * 守的是幾條會讓數字說謊的口徑：
 *  ① 時間窗是台北日曆日、到昨天為止（同一天不同時間按產生，數字不漂）
 *  ② 意圖只算有開 AI 判斷的標籤；推播讀不到時「沒收過推播」回 null，⛔ 不當成都沒收過
 *  ③ 新進名單的來源不算意圖、不猜刪掉的標籤
 *  ④ LINE 某天沒給就不補 0；同一天兩則推播不平分封鎖
 */
import { describe, expect, it } from 'vitest'
import {
  blockBaseline,
  fmt,
  intentTagStats,
  lineDayOfMs,
  lineFriendStats,
  lineQueryDates,
  newMemberSources,
  pushAudienceLabel,
  pushedUserSets,
  pushRows,
  pushStatsFinal,
  recentIntentPairs,
  recipientIdsNeeded,
  reportWindow,
  TAG_NAMES_UNREADABLE_LABEL,
  type BroadcastLite,
  type UserTagTimedRow,
} from './friend-report'
import { followUpAudienceText } from './broadcast-follow-up'

/** 2026-10-28 14:49 台北（MYFEEL 那份報告產生的時間） */
const NOW = Date.parse('2026-10-28T14:49:00+08:00')
const W = reportWindow(NOW)
const at = (taipei: string) => Date.parse(`${taipei}+08:00`)
const row = (userId: string, tagId: string, when: string | null): UserTagTimedRow =>
  ({ userId, tagId, createdAtMs: when ? at(when) : null })

describe('時間窗：台北日曆日、到昨天為止', () => {
  it('10/28 下午產生 → 9/28～10/27，前一段是 8/29～9/27', () => {
    expect(W.startDate).toBe('2026-09-28')
    expect(W.endDate).toBe('2026-10-27')
    expect(W.endMs).toBe(at('2026-10-28T00:00:00'))
    expect(W.startMs).toBe(at('2026-09-28T00:00:00'))
    expect(W.prevStartMs).toBe(at('2026-08-29T00:00:00'))
  })

  it('⛔ 同一天不同時間產生，窗口一模一樣（不是往回 30×24 小時）', () => {
    expect(reportWindow(at('2026-10-28T00:05:00'))).toEqual(W)
    expect(reportWindow(at('2026-10-28T23:55:00'))).toEqual(W)
  })

  it('LINE 的日子用日本時間切：台北 23:30 已經是日本隔天', () => {
    expect(lineDayOfMs(at('2026-09-29T23:30:00'))).toBe('2026-09-30')
    expect(lineDayOfMs(at('2026-09-29T12:00:00'))).toBe('2026-09-29')
  })

  it('問 LINE 的日子：窗口前一天（算增減的基準）到最後一天，共 31 天', () => {
    const d = lineQueryDates(W)
    expect(d[0]).toBe('2026-09-27')
    expect(d.at(-1)).toBe('2026-10-27')
    expect(d).toHaveLength(31)
  })

  it('大數字有千分位（舊版 10810 被讀成算錯過）', () => {
    expect(fmt(10810)).toBe('10,810')
    expect(fmt(121370)).toBe('121,370')
  })
})

describe('意圖標籤：最近 30 天 vs 前 30 天', () => {
  const tags = [
    { id: 'coffee', name: '在看咖啡機', category: 'interest', aiMode: 'auto' },
    { id: 'returns', name: '退換貨處理中', category: 'behavior', aiMode: 'suggest' },
    { id: 'survey', name: '問卷_小滑手', category: 'custom', aiMode: 'off' },
    { id: 'old', name: '停用的', category: 'interest', aiMode: 'auto', status: 'inactive' },
  ]
  const rows = [
    row('u1', 'coffee', '2026-10-20T10:00:00'),
    row('u2', 'coffee', '2026-09-28T00:00:00'), // 窗口第一秒算最近
    row('u3', 'coffee', '2026-09-27T23:59:59'), // 前一刻算前 30 天
    row('u4', 'coffee', '2026-10-28T00:00:00'), // 今天的不算（今天還沒過完）
    row('u5', 'coffee', null), // 舊資料沒有時間：算人數，不算進任何一段
    row('u1', 'survey', '2026-10-20T10:00:00'),
    row('u9', 'old', '2026-10-20T10:00:00'),
  ]

  it('只算有開 AI 判斷、還在用的標籤；⛔ 問卷名冊不在這裡', () => {
    const out = intentTagStats(rows, tags, W, null)
    expect(out.map(t => t.tagId)).toEqual(['coffee', 'returns'])
  })

  it('目前人數不分時間；最近／前 30 天照被貼上的時間分', () => {
    const coffee = intentTagStats(rows, tags, W, null).find(t => t.tagId === 'coffee')!
    expect(coffee.members).toBe(5)
    expect(coffee.recent).toBe(2)
    expect(coffee.prev).toBe(1)
  })

  it('⛔ 推播讀不到時，「最近沒收過推播」回 null，不可以當成都沒收過', () => {
    const coffee = intentTagStats(rows, tags, W, null).find(t => t.tagId === 'coffee')!
    expect(coffee.notPushedRecent).toBeNull()
    expect(coffee.pushedWithin7d).toBeNull()
  })

  it('有推播收件名單時，算出這群人裡幾位最近沒收過、幾位 7 天內收過', () => {
    const pushed = { within30: new Set(['u1', 'u2']), within7: new Set(['u1']) }
    const coffee = intentTagStats(rows, tags, W, pushed).find(t => t.tagId === 'coffee')!
    expect(coffee.notPushedRecent).toBe(3)
    expect(coffee.pushedWithin7d).toBe(1)
  })

  it('最近新增多的排前面', () => {
    const more = [...rows, row('a', 'returns', '2026-10-01T10:00:00'), row('b', 'returns', '2026-10-02T10:00:00'), row('c', 'returns', '2026-10-03T10:00:00')]
    expect(intentTagStats(more, tags, W, null)[0]!.tagId).toBe('returns')
  })
})

describe('意圖交集：只算兩顆都是最近 30 天新增的人', () => {
  it('⛔ 一顆很久以前、一顆最近的不算（那不是「最近在看又問了價格」）', () => {
    const rows = [
      row('u1', 'coffee', '2026-10-20T10:00:00'), row('u1', 'price', '2026-10-21T10:00:00'),
      row('u2', 'coffee', '2026-10-20T10:00:00'), row('u2', 'price', '2026-10-21T10:00:00'),
      row('u3', 'coffee', '2026-10-20T10:00:00'), row('u3', 'price', '2026-10-21T10:00:00'),
      row('u4', 'coffee', '2026-10-20T10:00:00'), row('u4', 'price', '2026-05-01T10:00:00'),
    ]
    expect(recentIntentPairs(rows, ['coffee', 'price'], W)).toEqual([{ a: 'coffee', b: 'price', users: 3 }])
  })

  it('不到 3 位不列（兩個人的交集是雜訊）', () => {
    const rows = [
      row('u1', 'coffee', '2026-10-20T10:00:00'), row('u1', 'price', '2026-10-21T10:00:00'),
      row('u2', 'coffee', '2026-10-20T10:00:00'), row('u2', 'price', '2026-10-21T10:00:00'),
    ]
    expect(recentIntentPairs(rows, ['coffee', 'price'], W)).toEqual([])
  })
})

describe('新進名單從哪裡來', () => {
  const tags = [
    { id: 'survey_a', name: '問卷_廚餘博士Pro', aiMode: 'off' },
    { id: 'survey_b', name: 'Tefal 問卷', aiMode: 'off' },
    { id: 'cs', name: '客服 - 小滑手', aiMode: 'off' },
    { id: 'coffee', name: '在看咖啡機', aiMode: 'auto' },
    { id: 'inactive', name: '60 天沒互動', code: 'sys_inactive' },
  ]

  it('照最早的一顆來源標籤分；⛔ 意圖不算來源（那是進來之後講的話）', () => {
    const out = newMemberSources(
      new Set(['n1', 'n2']),
      [
        row('n1', 'coffee', '2026-10-01T09:00:00'),
        row('n1', 'cs', '2026-10-01T10:00:00'),
        row('n1', 'survey_a', '2026-10-01T09:30:00'),
        row('n2', 'survey_a', '2026-10-02T09:00:00'),
      ],
      tags,
    )
    expect(out).toEqual([{ kind: 'tag', tagId: 'survey_a', name: '問卷_廚餘博士Pro', users: 2 }])
  })

  it('⛔ 封存掉的 AI 標籤也不算來源（封存不會從客人身上拿掉，C-404）', () => {
    const out = newMemberSources(
      new Set(['n1']),
      [row('n1', 'archived_ai', '2026-10-01T08:00:00'), row('n1', 'survey_b', '2026-10-01T09:00:00')],
      [...tags, { id: 'archived_ai', name: '問過價格優惠', aiMode: 'auto', status: 'inactive' }],
    )
    expect(out).toEqual([{ kind: 'tag', tagId: 'survey_b', name: 'Tefal 問卷', users: 1 }])
  })

  it('「沒互動」那顆、刪掉的標籤都不算來源；身上沒有來源標籤的人併成「沒有來源標籤」', () => {
    const out = newMemberSources(
      new Set(['n1', 'n2', 'n3']),
      [
        row('n1', 'inactive', '2026-10-01T09:00:00'),
        row('n2', 'deleted_tag', '2026-10-01T09:00:00'),
        row('n3', 'survey_b', '2026-10-01T09:00:00'),
      ],
      tags,
      { excludeTagIds: ['inactive'] },
    )
    expect(out).toEqual([
      { kind: 'tag', tagId: 'survey_b', name: 'Tefal 問卷', users: 1 },
      { kind: 'none', tagId: null, name: '沒有來源標籤', users: 2 },
    ])
  })

  it('前幾名以外併成「其他 N 種」，加起來等於新進總數', () => {
    const ids = new Set(['a1', 'a2', 'a3', 'b1', 'b2', 'c1'])
    const out = newMemberSources(
      ids,
      [
        row('a1', 'survey_a', '2026-10-01T09:00:00'), row('a2', 'survey_a', '2026-10-01T09:00:00'), row('a3', 'survey_a', '2026-10-01T09:00:00'),
        row('b1', 'survey_b', '2026-10-01T09:00:00'), row('b2', 'survey_b', '2026-10-01T09:00:00'),
        row('c1', 'cs', '2026-10-01T09:00:00'),
      ],
      tags,
      { top: 1 },
    )
    expect(out.map(r => [r.name, r.users])).toEqual([['問卷_廚餘博士Pro', 3], ['其他 2 種', 3]])
    expect(out.reduce((s, r) => s + r.users, 0)).toBe(ids.size)
  })
})

describe('推播', () => {
  const b = (over: Partial<BroadcastLite>): BroadcastLite => ({
    id: 'x', name: 'x', status: 'completed', completedMs: at('2026-10-04T12:00:00'),
    audienceSource: { type: 'tags', tagIds: ['gl'] }, sentCount: 100, opened: 30, clicked: 10,
    proposalTagId: null, resolvedUserIds: [], ...over,
  })
  const names = (id: string) => (id === 'gl' ? '問卷_珈樂堤_小滑手' : null)

  it('只列最近 30 天、真的送到 20 人以上的（⛔ 試發給自己那種 1 人的不列）', () => {
    const rows = pushRows([
      b({ id: 'ok' }),
      b({ id: 'one', sentCount: 1 }),
      b({ id: 'draft', status: 'draft' }),
      b({ id: 'old', completedMs: at('2026-09-20T12:00:00') }),
    ], W, names, NOW)
    expect(rows.map(r => r.id)).toEqual(['ok'])
    expect(rows[0]!.audience.tagNames).toEqual(['問卷_珈樂堤_小滑手'])
    expect(rows[0]!.audience.label).toBe('問卷_珈樂堤_小滑手')
  })

  it('⛔ 今天已經送完的也要列（C-404：只算到昨天的話，早上照提案發的那一則中午重新產生還看不到）', () => {
    const rows = pushRows([
      b({ id: 'ok' }),
      b({ id: 'today', completedMs: at('2026-10-28T09:00:00') }),
      b({ id: 'later', completedMs: at('2026-10-28T20:00:00') }), // 產生之後才送完的不算
    ], W, names, NOW)
    expect(rows.map(r => r.id)).toEqual(['today', 'ok'])
  })

  it('上一則發給同一群人的（可以在窗口外）跟推播成效頁同一支判斷', () => {
    const rows = pushRows([
      b({ id: 'launch', name: '小滑手_開賣', completedMs: at('2026-09-29T12:00:00'), sentCount: 2187, opened: 786 }),
      b({ id: 'countdown', name: '小滑手_超早鳥倒數', completedMs: at('2026-10-04T12:00:00'), sentCount: 2165, opened: 466 }),
    ], W, names, NOW)
    const countdown = rows.find(r => r.id === 'countdown')!
    expect(countdown.prevOpen?.name).toBe('小滑手_開賣')
    expect(countdown.prevOpen?.openRate).toBeCloseTo(0.3594, 4)
  })

  it('刪掉的標籤不猜名字', () => {
    const rows = pushRows([b({ audienceSource: { type: 'tags', tagIds: ['gone'] } })], W, names, NOW)
    expect(rows[0]!.audience.tagNames).toEqual(['(已刪除的標籤)'])
  })

  it('⛔ 標籤這次讀不到（傳 null）→ 講「標籤名稱這次讀不到」，不寫成「已刪除的標籤」（code review 抓到）', () => {
    const rows = pushRows([b({ audienceSource: { type: 'tags', tagIds: ['t1', 't2'] } })], W, null, NOW)
    expect(rows[0]!.audience.tagNames).toEqual([])
    expect(rows[0]!.audience.label).toBe(TAG_NAMES_UNREADABLE_LABEL)
    expect(JSON.stringify(rows[0])).not.toContain('已刪除')
  })

  it('「發給」那一欄：補發講得出補發給哪一則的誰（⛔ 不寫看不懂的「指定名單」）', () => {
    expect(pushAudienceLabel({ type: 'followUp', sourceBroadcastId: 'x', followUpTarget: 'unopened', sourceName: '小滑手_開賣' }, []))
      .toBe('補發給「小滑手_開賣」沒打開的人')
    expect(pushAudienceLabel({ type: 'all' }, [])).toBe('全部好友')
    expect(pushAudienceLabel({ type: 'import' }, [])).toBe('匯入的名單')
  })

  it('⛔ 補發那一句跟推播頁同一支：點了／沒點連結的是「發給」不是「補發給」（code review 抓到兩邊講不一樣）', () => {
    for (const target of ['unopened', 'clicked', 'unclicked'] as const) {
      expect(pushAudienceLabel({ type: 'followUp', sourceBroadcastId: 'x', followUpTarget: target, sourceName: '小滑手_開賣' }, []))
        .toBe(followUpAudienceText('小滑手_開賣', target))
    }
    expect(pushAudienceLabel({ type: 'followUp', followUpTarget: 'clicked', sourceName: '小滑手_開賣' }, [])).toBe('發給「小滑手_開賣」點了連結的人')
  })

  it('LINE 數字定了沒：看存到哪一輪；舊存檔沒有那一欄才看天數', () => {
    const rows = pushRows([b({ statsFinal: false }), b({ id: 'f', statsFinal: true })], W, names, NOW)
    expect(rows.map(r => r.statsFinal)).toEqual([false, true])
    expect(pushStatsFinal({ statsFinal: false, completedMs: NOW - 30 * 86_400_000 }, NOW)).toBe(false)
    expect(pushStatsFinal({ completedMs: NOW - 8 * 86_400_000 }, NOW)).toBe(true)
    expect(pushStatsFinal({ completedMs: NOW - 2 * 86_400_000 }, NOW)).toBe(false)
  })

  it('誰最近收過推播：30 天內與 7 天內分開算，⛔ 算到產生那一刻（今天早上發的也算）', () => {
    const sets = pushedUserSets([
      b({ completedMs: at('2026-10-28T09:00:00'), resolvedUserIds: ['u0'] }),
      b({ completedMs: at('2026-10-25T12:00:00'), resolvedUserIds: ['u1'] }),
      b({ completedMs: at('2026-10-05T12:00:00'), resolvedUserIds: ['u2'] }),
      b({ completedMs: at('2026-09-01T12:00:00'), resolvedUserIds: ['u3'] }),
    ], W, NOW)
    expect([...sets.within30].sort()).toEqual(['u0', 'u1', 'u2'])
    expect([...sets.within7].sort()).toEqual(['u0', 'u1'])
  })

  it('⛔ 補發（LINE 不給名單）用它補的那一則的名單代替，不可以當成誰都沒收到', () => {
    const all = [
      b({ id: 'src', completedMs: at('2026-09-20T12:00:00'), resolvedUserIds: ['a', 'b', 'c'] }), // 窗口外的原推播
      b({ id: 'fu', completedMs: at('2026-10-26T12:00:00'), audienceSource: { type: 'followUp', sourceBroadcastId: 'src', followUpTarget: 'unopened' }, resolvedUserIds: [] }),
    ]
    expect(recipientIdsNeeded(all, W, NOW).sort()).toEqual(['fu', 'src'])
    const sets = pushedUserSets(all, W, NOW)
    expect([...sets.within7].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('LINE 好友數與封鎖', () => {
  const dates = ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']

  it('頭尾相減＝這段期間新加與多封鎖；每天的封鎖＝跟前一天相減', () => {
    const s = lineFriendStats({
      '2026-09-27': { followers: 100, blocks: 10 },
      '2026-09-28': { followers: 110, blocks: 12 },
      '2026-09-29': { followers: 115, blocks: 20 },
      '2026-09-30': { followers: 120, blocks: 21 },
    }, dates)
    expect(s).toMatchObject({ status: 'ok', followers: 120, followersDelta: 20, blocks: 21, blocksDelta: 11, asOfDate: '2026-09-30' })
    expect(s.blocksByDay).toEqual({ '2026-09-28': 2, '2026-09-29': 8, '2026-09-30': 1 })
  })

  it('⛔ 某天 LINE 沒給：那天跟隔天都不在每日封鎖裡（不補 0）', () => {
    const s = lineFriendStats({
      '2026-09-27': { followers: 100, blocks: 10 },
      '2026-09-28': null,
      '2026-09-29': { followers: 115, blocks: 20 },
      '2026-09-30': { followers: 120, blocks: 21 },
    }, dates)
    expect(s.blocksByDay).toEqual({ '2026-09-30': 1 })
  })

  it('最後一天 LINE 還沒算好：用拿得到的最近一天、標 partial', () => {
    const s = lineFriendStats({
      '2026-09-27': { followers: 100, blocks: 10 },
      '2026-09-28': { followers: 110, blocks: 12 },
      '2026-09-29': { followers: 115, blocks: 20 },
      '2026-09-30': null,
    }, dates)
    expect(s).toMatchObject({ status: 'partial', followers: 115, asOfDate: '2026-09-29', followersDelta: 15 })
  })

  it('每一天都沒有 → failed，數字全是 null（⛔ 不是 0）', () => {
    const s = lineFriendStats({}, dates)
    expect(s).toMatchObject({ status: 'failed', followers: null, blocks: null })
  })

  it('沒有基準日（窗口前一天）就算不出增減，但數字照給', () => {
    const s = lineFriendStats({ '2026-09-30': { followers: 120, blocks: 21 } }, dates)
    expect(s).toMatchObject({ followers: 120, followersDelta: null, blocksDelta: null })
  })
})

describe('平常一天封鎖幾位', () => {
  const days = (vals: Record<string, number>) => vals

  it('沒發推播的日子取中位數；推播當天與隔天都排除', () => {
    const byDay = days({
      '2026-09-28': 10, '2026-09-29': 29, '2026-09-30': 30, '2026-10-01': 9,
      '2026-10-02': 11, '2026-10-03': 10, '2026-10-06': 12, '2026-10-07': 8,
    })
    expect(blockBaseline(byDay, new Set(['2026-09-29']))).toBe(10)
  })

  it('能比的日子不到 5 天就不講平常（null）', () => {
    expect(blockBaseline(days({ '2026-09-28': 10, '2026-09-29': 30 }), new Set(['2026-09-29']))).toBeNull()
  })
})
