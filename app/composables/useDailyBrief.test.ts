/**
 * 後台小幫手「昨日摘要」卡的資料（`useDailyBrief`）。
 *
 * 釘兩件事（`C-362`）：
 * ① **不可以排成兩輪**：統計查詢在正式站量過最慢 4.4 秒。原本先等「這次講哪幾天」回來才查比較與基準，
 *    每次打開都多等一整輪。絕大多數日子就是昨天一天，三支要同時出去；真的是好幾天才補查兩支。
 * ② **比較那段不可以跟這段重疊**：春節後一次講 8 天，只退 7 天的話第一天兩邊都算到。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'

const states = new Map<string, Ref<unknown>>()
const g = globalThis as Record<string, unknown>
g.useState = (key: string, init: () => unknown) => {
  if (!states.has(key))
    states.set(key, ref(init()))
  return states.get(key)!
}

/** 每一支請求都由測試決定什麼時候回來 */
interface Pending { params: Record<string, string>, resolve: (v: unknown) => void, reject: (e: unknown) => void }
let pending: Pending[] = []
const apiFetch = vi.fn((_url: string, opts: { params: Record<string, string> }) =>
  new Promise((resolve, reject) => { pending.push({ params: opts.params, resolve, reject }) }))
g.useWorkspace = () => ({ workspaceId: ref('ws1'), apiFetch })

const { useDailyBrief } = await import('./useDailyBrief')

const kpi = (over: Record<string, unknown> = {}) => ({
  total: 10, aiHandled: 6, botHandled: 1, humanHandled: 2, unhandled: 1, handoffCount: 3, newFriends: 2,
  unhandledSamples: [], handoffWaitExceeded: 0, handoffWaitSlaMinutes: 30, handoffWaitOffHours: 0, handoffWaitSamples: [],
  ...over,
})
const flush = () => new Promise(r => setTimeout(r, 0))
const digestCall = () => pending.find(p => p.params.window === 'digest')!
/** 頭一支這天開始的查詢（各案例裡只在不會撞的時候用） */
const rangeCall = (startDate: string) => pending.find(p => p.params.startDate === startDate)

beforeEach(() => {
  states.clear()
  pending = []
  apiFetch.mockClear()
  // 台北 2026-10-21（三）13:00
  vi.useFakeTimers({ now: new Date('2026-10-21T05:00:00Z'), toFake: ['Date'] })
})

describe('useDailyBrief', () => {
  it('平常的一天：三支一起出去，⛔ 不等「講哪幾天」回來才查另外兩支', async () => {
    const { brief, refresh } = useDailyBrief()
    const done = refresh()
    await flush()

    // 第一支還沒回來，三支都已經出去了
    expect(pending.map(p => p.params)).toEqual(expect.arrayContaining([
      { window: 'digest' },
      { startDate: '2026-10-19', endDate: '2026-10-19' }, // 前天
      { startDate: '2026-10-13', endDate: '2026-10-19' }, // 基準：前 7 天
    ]))
    expect(pending).toHaveLength(3)

    rangeCall('2026-10-19')!.resolve(kpi({ total: 7 }))
    rangeCall('2026-10-13')!.resolve(kpi({ total: 70 }))
    digestCall().resolve(kpi({ rangeStart: '2026-10-20', rangeEnd: '2026-10-20' }))
    await done

    expect(apiFetch).toHaveBeenCalledTimes(3) // 沒有補查
    expect(brief.value).toMatchObject({ date: '2026-10-20', startDate: '2026-10-20', days: 1, compareLabel: '前天' })
    expect(brief.value!.dayBefore.total).toBe(7)
    expect(brief.value!.baseline!.total).toBe(10)
  })

  it('春節後一次講 8 天：補查「兩週前同一段」，⛔ 不跟這段重疊；先出去的那兩支失敗也不拖垮', async () => {
    const { brief, refresh } = useDailyBrief()
    const done = refresh()
    await flush()
    // 先出去的單日那兩支剛好失敗——用不到，不可以變成整份日報失敗
    rangeCall('2026-10-19')!.reject(new Error('boom'))
    rangeCall('2026-10-13')!.reject(new Error('boom'))
    digestCall().resolve(kpi({ total: 80, rangeStart: '2027-02-03', rangeEnd: '2027-02-10' }))
    await flush()

    const compare = rangeCall('2027-01-20')
    const base = rangeCall('2027-01-27')
    expect(compare?.params).toEqual({ startDate: '2027-01-20', endDate: '2027-01-27' })
    expect(base?.params).toEqual({ startDate: '2027-01-27', endDate: '2027-02-02' })
    compare!.resolve(kpi({ total: 50 }))
    base!.resolve(kpi({ total: 70 }))
    await done

    expect(brief.value).toMatchObject({ date: '2027-02-10', startDate: '2027-02-03', days: 8, compareLabel: '兩週前同期' })
    expect(brief.value!.yesterday.total).toBe(80)
    expect(brief.value!.dayBefore.total).toBe(50)
  })

  it('週一講三天 → 比上週同一段', async () => {
    const { brief, refresh } = useDailyBrief()
    const done = refresh()
    await flush()
    digestCall().resolve(kpi({ rangeStart: '2026-10-16', rangeEnd: '2026-10-18' }))
    await flush()
    const call = (startDate: string, endDate: string) =>
      pending.find(p => p.params.startDate === startDate && p.params.endDate === endDate)
    // 比較＝上週五～週日；基準＝第一天之前 7 天（兩支剛好同一天開始）
    call('2026-10-09', '2026-10-11')!.resolve(kpi({ total: 33 }))
    call('2026-10-09', '2026-10-15')!.resolve(kpi())
    await done

    expect(brief.value).toMatchObject({ days: 3, compareLabel: '上週同期' })
    expect(brief.value!.dayBefore.total).toBe(33)
  })
})
