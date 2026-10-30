import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 半夜少發保溫（`D-47`②，2026-10-20 老闆照建議）：台北 01:00–07:00 只保母請求、不發子請求。
 * 白天子請求只在整 5 分那輪發 3 個（`D-164`⑤，2026-10-30 老闆「做」），母請求照每分鐘。
 * 釘的是**端點真的少發**（不是只有常數對）：數 `$fetch` 打到 `/api/warmup?depth=1` 幾次。
 */

vi.mock('~~/server/utils/cron-auth', () => ({ assertCronAuthorized: vi.fn() }))
vi.mock('~~/server/utils/line-workspace-credentials', () => ({ listWorkspaceLineCredentials: vi.fn(async () => [{ workspaceId: 'w1' }]) }))
vi.mock('~~/server/utils/handler', () => ({ warmWorkspaceAutomationCaches: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))

const fetched: string[] = []
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => ({}))
vi.stubGlobal('getHeader', () => undefined)
vi.stubGlobal('useRuntimeConfig', () => ({ appBaseUrl: 'https://example.test', cronSecret: 's3cret' }))
vi.stubGlobal('$fetch', async (url: string) => {
  fetched.push(url)
  return url.includes('depth=1') ? { xffHops: 2 } : '<html></html>'
})

const { default: handler } = await import('./warmup.get')
const { isWarmupOffPeak, warmChildrenAt, WARM_CHILDREN, OFF_PEAK_TAIPEI_HOURS } = await import('~~/server/utils/warmup-plan')
const { warmWorkspaceAutomationCaches } = await import('~~/server/utils/handler')

/** 台北時間 hh:mm 的那一刻（台北＝UTC+8） */
const taipei = (hh: number, mm = 0) => new Date(Date.UTC(2026, 9, 20, hh - 8, mm))
const run = () => (handler as (e: unknown) => Promise<{ childrenTotal: number, offPeak: boolean }>)({})
const children = () => fetched.filter(u => u.includes('/api/warmup?depth=1')).length

beforeEach(() => {
  fetched.length = 0
  vi.mocked(warmWorkspaceAutomationCaches).mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('子保溫數跟著台北時間走', () => {
  it('邊界：00:55 照舊、01:00 起只保母請求、06:55 還是半夜、07:00 恢復', () => {
    expect(warmChildrenAt(taipei(0, 55))).toBe(WARM_CHILDREN)
    expect(warmChildrenAt(taipei(1, 0))).toBe(0)
    expect(warmChildrenAt(taipei(6, 55))).toBe(0)
    expect(warmChildrenAt(taipei(7, 0))).toBe(WARM_CHILDREN)
    expect(OFF_PEAK_TAIPEI_HOURS).toEqual({ from: 1, to: 7 })
  })

  it('白天只在整 5 分那輪發：12:00、12:05、12:55 發，中間四輪不發', () => {
    expect(warmChildrenAt(taipei(12, 0))).toBe(WARM_CHILDREN)
    for (const mm of [1, 2, 3, 4]) expect(warmChildrenAt(taipei(12, mm))).toBe(0)
    expect(warmChildrenAt(taipei(12, 5))).toBe(WARM_CHILDREN)
    expect(warmChildrenAt(taipei(12, 55))).toBe(WARM_CHILDREN)
    expect(warmChildrenAt(taipei(12, 59))).toBe(0)
    // 排程晚幾秒才到也算同一輪（12:05:40 還是整 5 分那輪）
    expect(warmChildrenAt(new Date(taipei(12, 5).getTime() + 40_000))).toBe(WARM_CHILDREN)
  })

  it('白天一小時加起來是 12 輪×3 個＝36 個（以前每分鐘 180 個）', () => {
    let total = 0
    for (let mm = 0; mm < 60; mm++) total += warmChildrenAt(taipei(15, mm))
    expect(total).toBe(36)
  })

  it('看的是台北時間不是主機時間（UTC 17:30＝台北 01:30）', () => {
    expect(isWarmupOffPeak(new Date(Date.UTC(2026, 9, 20, 17, 30)))).toBe(true)
    expect(isWarmupOffPeak(new Date(Date.UTC(2026, 9, 20, 1, 30)))).toBe(false) // 台北 09:30
  })
})

describe('GET /api/warmup 真的少發', () => {
  it('台北 03:00：一個子請求都不發，母請求的頁面渲染照樣暖', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(taipei(3))
    const res = await run()
    expect(children()).toBe(0)
    expect(res).toMatchObject({ childrenTotal: 0, offPeak: true })
    expect(fetched).toEqual(expect.arrayContaining(['/']))
  })

  it('台北 12:00：照舊 3 個子請求', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(taipei(12))
    const res = await run()
    expect(children()).toBe(3)
    expect(res).toMatchObject({ childrenTotal: 3, offPeak: false })
  })

  it('台北 12:03：不發子請求，但快取預熱和兩條頁面渲染照做（母請求每分鐘的工作不能少）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(taipei(12, 3))
    const res = await run()
    expect(children()).toBe(0)
    expect(res).toMatchObject({ childrenTotal: 0, offPeak: false })
    expect(warmWorkspaceAutomationCaches).toHaveBeenCalledWith('w1')
    expect(fetched).toEqual(expect.arrayContaining(['/', '/liff/lead']))
  })
})
