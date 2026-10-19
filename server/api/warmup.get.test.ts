import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 半夜少發保溫（`D-47`②，2026-10-20 老闆照建議）：台北 01:00–07:00 只保母請求、不發子請求，白天照舊 3 個。
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

/** 台北時間 hh:mm 的那一刻（台北＝UTC+8） */
const taipei = (hh: number, mm = 0) => new Date(Date.UTC(2026, 9, 20, hh - 8, mm))
const run = () => (handler as (e: unknown) => Promise<{ childrenTotal: number, offPeak: boolean }>)({})
const children = () => fetched.filter(u => u.includes('/api/warmup?depth=1')).length

beforeEach(() => { fetched.length = 0 })
afterEach(() => { vi.useRealTimers() })

describe('子保溫數跟著台北時間走', () => {
  it('邊界：00:59 照舊、01:00 起只保母請求、06:59 還是半夜、07:00 恢復', () => {
    expect(warmChildrenAt(taipei(0, 59))).toBe(WARM_CHILDREN)
    expect(warmChildrenAt(taipei(1, 0))).toBe(0)
    expect(warmChildrenAt(taipei(6, 59))).toBe(0)
    expect(warmChildrenAt(taipei(7, 0))).toBe(WARM_CHILDREN)
    expect(OFF_PEAK_TAIPEI_HOURS).toEqual({ from: 1, to: 7 })
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
})
