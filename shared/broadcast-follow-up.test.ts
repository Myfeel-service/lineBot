import { describe, expect, it } from 'vitest'
import {
  followUpAudienceText,
  followUpAvailability,
  followUpDraftName,
  followUpRecipient,
  followUpSourceProblem,
  narrowcastFailureText,
  planNarrowcastSend,
  type FollowUpSourceInfo,
} from './broadcast-follow-up'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 28, 4)

/** 小滑手_開賣：2,187 送、786 開、443 點，用 narrowcast 送、發完 2 天 */
const src = (over: Partial<FollowUpSourceInfo> = {}): FollowUpSourceInfo => ({
  status: 'completed',
  sendMode: 'narrowcast',
  isFollowUp: false,
  lineRequestId: 'req-1',
  uploadAudienceGroupId: 111,
  narrowcastFallback: null,
  completedMs: NOW - 2 * DAY,
  sentCount: 2187,
  opened: 786,
  clicked: 443,
  nowMs: NOW,
  ...over,
})

describe('followUpAvailability：報表上能出現哪幾顆、不能時講什麼', () => {
  it('都夠 → 三顆，人數：沒打開＝送出－打開（約）、點了＝點的人、沒點＝送出－點的人（約）', () => {
    const a = followUpAvailability(src())
    expect(a.reason).toBeNull()
    expect(a.options).toEqual([
      { target: 'unopened', button: '補發給沒打開的人', estimate: 1401, approx: true },
      { target: 'clicked', button: '發給點了連結的人', estimate: 443, approx: false },
      { target: 'unclicked', button: '發給沒點連結的人', estimate: 1744, approx: true },
    ])
  })

  it('點的人不到 50 → 只有「沒打開」，並講為什麼沒有點了／沒點', () => {
    const a = followUpAvailability(src({ clicked: 28 }))
    expect(a.options.map(o => o.target)).toEqual(['unopened'])
    expect(a.reason).toBe('點連結的人不到 50 位，LINE 不提供名單，所以沒辦法分「點了／沒點」。')
  })

  it.each([
    ['放了客人名字（一人一則送）', { sendMode: 'perRecipient' }, '這則放了客人名字（或「點了就貼標」的按鈕），是一人一則送的，LINE 不提供看過的人名單，所以不能補發。下次想補發，內容就別放這兩樣。'],
    ['以前的送法', { sendMode: undefined, lineRequestId: null }, '這則是用以前的方式送出的，LINE 沒辦法圈出看過的人；之後新發、沒放客人名字的推播就可以補發。'],
    ['改用一般方式送（記了原因）', { sendMode: 'multicast', narrowcastFallback: '發給不到 50 人' }, '這則用一般方式送出（發給不到 50 人），LINE 沒辦法圈出看過的人，所以不能補發。'],
    ['補發的那一則', { isFollowUp: true }, '這則是補發的那一則，不能再從它補發；要再發一次，請回到原本那一則。'],
    ['超過 60 天', { completedMs: NOW - 61 * DAY }, '發完超過 60 天，LINE 不再提供看過的人名單，所以不能補發。'],
    ['看過的不到 50、點的也不到', { opened: 40, clicked: 10 }, '看過的人不到 50 位，LINE 不提供名單，所以不能補發。'],
  ])('%s → 不出按鈕、講原因', (_l, over, reason) => {
    expect(followUpAvailability(src(over as Partial<FollowUpSourceInfo>))).toEqual({ options: [], reason })
  })

  it('剛發完 LINE 還沒算出打開數 → 講「發完隔天就能補發」，⛔ 不要講成不到 50 位', () => {
    expect(followUpAvailability(src({ completedMs: NOW - 3 * 3600_000, opened: null, clicked: null })).reason)
      .toBe('發完隔天就能補發：LINE 要先算出誰打開了。')
  })

  it('還沒送完、沒送到人 → 整區不出現（不講原因）', () => {
    expect(followUpAvailability(src({ status: 'processing' }))).toEqual({ options: [], reason: null })
    expect(followUpAvailability(src({ sentCount: 0 }))).toEqual({ options: [], reason: null })
  })
})

describe('followUpRecipient：送給誰（LINE 的條件）', () => {
  it('沒打開＝原本名單扣掉看過的；沒點＝原本名單扣掉點過的；點了＝點過的那份', () => {
    const minus = { type: 'operator', and: [{ type: 'audience', audienceGroupId: 1 }, { type: 'operator', not: { type: 'audience', audienceGroupId: 2 } }] }
    expect(followUpRecipient('unopened', 1, 2)).toEqual(minus)
    expect(followUpRecipient('unclicked', 1, 2)).toEqual(minus)
    expect(followUpRecipient('clicked', 1, 2)).toEqual({ type: 'audience', audienceGroupId: 2 })
  })
})

describe('planNarrowcastSend：一般推播要不要用 narrowcast 送', () => {
  it('50 人以上、沒有發完貼記號、開關沒關 → 用', () => {
    expect(planNarrowcastSend({ disabled: false, recipientCount: 50, completionTagCount: 0 })).toEqual({ use: true, fallback: null })
  })
  it('不用時一定帶原因（報表講「為什麼不能補發」）', () => {
    expect(planNarrowcastSend({ disabled: false, recipientCount: 49, completionTagCount: 0 }).fallback).toBe('發給不到 50 人')
    expect(planNarrowcastSend({ disabled: false, recipientCount: 500, completionTagCount: 1 }).fallback).toContain('發完貼記號')
    expect(planNarrowcastSend({ disabled: true, recipientCount: 500, completionTagCount: 0 }).fallback).toBe('系統暫時改用一般方式送')
  })
})

describe('followUpSourceProblem：送出前原本那則還能不能用', () => {
  const ok = { workspaceId: 'w1', sendMode: 'narrowcast', lineRequestId: 'r', uploadAudienceGroupId: 1, completedMs: NOW - DAY }
  it('能＝null；別家的／不在了／不是 narrowcast／超過 60 天各講一句', () => {
    expect(followUpSourceProblem(ok, 'w1', NOW)).toBeNull()
    expect(followUpSourceProblem(null, 'w1', NOW)).toBe('原本那則推播已經不在了')
    expect(followUpSourceProblem({ ...ok, workspaceId: 'w2' }, 'w1', NOW)).toBe('原本那則推播已經不在了')
    expect(followUpSourceProblem({ ...ok, sendMode: 'multicast' }, 'w1', NOW)).toBe('原本那則不是用可以補發的方式送的')
    expect(followUpSourceProblem({ ...ok, completedMs: NOW - 61 * DAY }, 'w1', NOW)).toBe('原本那則發完超過 60 天，LINE 不再提供名單')
  })
})

describe('字', () => {
  it('草稿名字、發送對象那一行', () => {
    expect(followUpDraftName('小滑手_開賣', 'unopened')).toBe('小滑手_開賣－補發給沒打開的人')
    expect(followUpAudienceText('小滑手_開賣', 'unopened')).toBe('補發給「小滑手_開賣」沒打開的人')
    expect(followUpAudienceText('小滑手_開賣', 'clicked')).toBe('發給「小滑手_開賣」點了連結的人')
  })
  it('LINE 送失敗的原因', () => {
    expect(narrowcastFailureText(2)).toBe('人數不夠，LINE 沒有送出')
    expect(narrowcastFailureText(4)).toBe('LINE 圈出的「看過／點過的人」不到 50 位，沒有送出')
    expect(narrowcastFailureText(1, 'internal')).toBe('LINE 沒有送出（internal）')
  })
})
