/**
 * 問小幫手「LINE 還剩幾則？」（`D-146`，2026-10-22）。
 *
 * 以前小幫手只查得到 AI 回覆額度，問 LINE 剩幾則會被拿那個數字回答——那是另一種「則」。
 * 釘住的是：分得出沒接 LINE／問不到、用在哪的比例算對（回覆客人不算進去）、說明裡講清楚兩種「則」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'ts' }), increment: (n: number) => ({ __op: 'inc', n }) },
}))
vi.mock('./firebase', () => ({ getDb: vi.fn(), getFirebaseAuth: vi.fn() }))
vi.mock('./gemini', () => ({ generateJson: vi.fn() }))
vi.mock('./tagging', () => ({ addTagsToUser: vi.fn() }))
const { readLineMessageQuota, getLineMonthSendBreakdown } = vi.hoisted(() => ({
  readLineMessageQuota: vi.fn(),
  getLineMonthSendBreakdown: vi.fn(),
}))
vi.mock('./line', () => ({ readLineMessageQuota, getLineMonthSendBreakdown }))

;(globalThis as any).createError = (o: any) => Object.assign(new Error(o?.statusMessage || 'error'), o)

const { TOOLS } = await import('./ai-admin-agent')
const tool = TOOLS.get_line_quota
const run = () => tool.run({} as any, 'w1', {}, {}) as Promise<any>

beforeEach(() => {
  readLineMessageQuota.mockReset()
  getLineMonthSendBreakdown.mockReset()
})

describe('查詢：LINE 訊息還剩幾則', () => {
  it('上限、已送、還剩、幾級、幾號重算；這個月用在哪的比例只算會扣則數的兩種', async () => {
    readLineMessageQuota.mockResolvedValue({ kind: 'ok', quota: { limit: 306000, used: 6810, remaining: 299190 } })
    getLineMonthSendBreakdown.mockResolvedValue({ multicast: 5500, push: 1267, reply: 2215, throughLabel: '10/21', missingDays: 0 })
    const r = await run()
    expect(r).toMatchObject({
      state: 'ok',
      unlimited: false,
      limit: 306000,
      usedApprox: 6810,
      remainingApprox: 299190,
      level: 'ok',
    })
    expect(r.resetsOn).toMatch(/^\d+\/1$/)
    expect(r.thisMonthByType).toMatchObject({
      countedThrough: '10/21',
      groupBroadcasts: 5500,
      groupBroadcastsPercentOfCounted: 81,
      oneByOne: 1267,
      oneByOnePercentOfCounted: 19,
      repliesNotCounted: 2215,
    })
  })

  it('沒接 LINE／問不到：照實回，不給數字', async () => {
    readLineMessageQuota.mockResolvedValue({ kind: 'unconfigured' })
    expect(await run()).toEqual({ state: 'unconfigured' })
    readLineMessageQuota.mockResolvedValue({ kind: 'error', detail: 'LINE 超過 4 秒沒回' })
    expect(await run()).toEqual({ state: 'error', detail: 'LINE 超過 4 秒沒回' })
    expect(getLineMonthSendBreakdown).not.toHaveBeenCalled()
  })

  it('用在哪問不到 → 只回剩幾則，用在哪那格是 null', async () => {
    readLineMessageQuota.mockResolvedValue({ kind: 'ok', quota: { limit: 3000, used: 3000, remaining: 0 } })
    getLineMonthSendBreakdown.mockResolvedValue(null)
    expect(await run()).toMatchObject({ state: 'ok', level: 'over', thisMonthByType: null })
  })

  it('⭐ 說明講清楚：這不是 AI 回覆額度、一律說「約」、上限含加購', () => {
    expect(tool.description).toContain('get_plan_quota')
    expect(tool.description).toContain('約')
    expect(tool.description).toContain('加購')
    expect(tool.requires).toBe('workspace.read')
    expect(tool.mutates).toBe(false)
  })
})
