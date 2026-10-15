import { beforeEach, describe, expect, it, vi } from 'vitest'

const pushMock = vi.fn()

vi.mock('@line/bot-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line/bot-sdk')>()
  return {
    ...actual,
    messagingApi: {
      ...actual.messagingApi,
      MessagingApiClient: class { pushMessage = pushMock },
      MessagingApiBlobClient: class {},
    },
  }
})
vi.mock('./line-workspace-credentials', () => ({
  getLineWorkspaceCredentials: vi.fn(async () => ({ channelAccessToken: 'token', channelSecret: 'secret' })),
}))

import { HTTPFetchError } from '@line/bot-sdk'
import { pushMessagesPerRecipient } from './line'

function lineError(status: number, message: string) {
  return new HTTPFetchError('Request failed', {
    status,
    statusText: '',
    headers: new Headers(),
    body: JSON.stringify({ message }),
  })
}

const noSleep = async () => {}
const build = (id: string) => [{ type: 'text' as const, text: `hi ${id}` }]
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ lineUserId: `U${i + 1}`, retryKey: `key-${i + 1}` }))

beforeEach(() => {
  pushMock.mockReset()
})

/**
 * `D-118` A：用了客人名字的推播一人一則送。這一支是送出的地基：
 * 重送編號帶著送、409 算收到、送太快會退避重試、本月額度用完整批停下來。
 */
describe('pushMessagesPerRecipient', () => {
  it('每一位送自己那一份、帶自己的重送編號與彙總單位', async () => {
    pushMock.mockResolvedValue({})

    const res = await pushMessagesPerRecipient(people(2), build, 'w1', { customAggregationUnits: ['u1'], sleep: noSleep })

    expect(res).toMatchObject({ successCount: 2, failedIds: [], lineAggregationApplied: true, stoppedReason: null })
    const calls = pushMock.mock.calls.map(c => ({ body: c[0], key: c[1] }))
    expect(calls).toContainEqual({ body: { to: 'U1', messages: build('U1'), customAggregationUnits: ['u1'] }, key: 'key-1' })
    expect(calls).toContainEqual({ body: { to: 'U2', messages: build('U2'), customAggregationUnits: ['u1'] }, key: 'key-2' })
  })

  /** ⛔ 409＝同一個重送編號上一輪 LINE 已經收下：他收到了，不可以記成沒收到 */
  it('409（上一輪已收下）算送達，另外記 alreadySentCount', async () => {
    pushMock.mockImplementation(async (body: { to: string }) => {
      if (body.to === 'U2') throw lineError(409, 'The retry key is already accepted')
      return {}
    })

    const res = await pushMessagesPerRecipient(people(3), build, 'w1', { sleep: noSleep })

    expect(res).toMatchObject({ successCount: 3, alreadySentCount: 1, failedIds: [] })
  })

  it('送太快（429）用同一個編號退避重試，重試成功就算送達', async () => {
    let tries = 0
    pushMock.mockImplementation(async (_body: unknown, key: string) => {
      tries++
      expect(key).toBe('key-1')
      if (tries < 3) throw lineError(429, 'Too many requests')
      return {}
    })

    const res = await pushMessagesPerRecipient(people(1), build, 'w1', { sleep: noSleep })

    expect(tries).toBe(3)
    expect(res).toMatchObject({ successCount: 1, failedIds: [] })
  })

  it('封鎖這種重試也不會變的錯：不重試，記下那一位的原因，其他人照送', async () => {
    pushMock.mockImplementation(async (body: { to: string }) => {
      if (body.to === 'U1') throw lineError(400, "The user hasn't added the LINE Official Account as a friend, or has blocked the LINE Official Account.")
      return {}
    })

    const res = await pushMessagesPerRecipient(people(3), build, 'w1', { sleep: noSleep })

    expect(pushMock.mock.calls.filter(c => c[0].to === 'U1')).toHaveLength(1)
    expect(res.successCount).toBe(2)
    expect(res.failedIds).toEqual(['U1'])
    expect(res.failureReasons.U1).toContain('封鎖')
  })

  /** ⛔ 本月額度用完也是 429，但重試沒用、下一位也一樣——不停的話 9 千位每位退避 3 秒半 */
  it('本月額度用完：整批停下來，剩下的人不再打 LINE', async () => {
    pushMock.mockImplementation(async (body: { to: string }) => {
      if (body.to === 'U1') return {}
      throw lineError(429, 'You have reached your monthly limit.')
    })

    const res = await pushMessagesPerRecipient(people(20), build, 'w1', { concurrency: 1, sleep: noSleep })

    expect(res.successCount).toBe(1)
    expect(res.failedIds).toHaveLength(19)
    expect(res.stoppedReason).toContain('本月推播則數已用完')
    // 第 2 位撞到額度就停：之後一位都沒再打（不重試、不繼續）
    expect(pushMock).toHaveBeenCalledTimes(2)
    expect(res.failureReasons.U20).toContain('本月推播則數已用完')
  })

  it('彙總單位被退回、拿掉就收下 → 之後每一位都不帶，而且換一個重送編號', async () => {
    pushMock.mockImplementation(async (body: { customAggregationUnits?: string[] }) => {
      if (body.customAggregationUnits) throw lineError(400, 'Invalid customAggregationUnits')
      return {}
    })

    const res = await pushMessagesPerRecipient(people(3), build, 'w1', { customAggregationUnits: ['u1'], sleep: noSleep })

    expect(res).toMatchObject({ successCount: 3, lineAggregationApplied: false })
    const plainCalls = pushMock.mock.calls.filter(c => !c[0].customAggregationUnits)
    expect(plainCalls).toHaveLength(3)
    // 內容不一樣了就不能沿用原本的編號（LINE：同一個編號重送時內容要一模一樣）；推出來的是固定的
    expect(plainCalls[0]![1]).not.toBe('key-1')
    expect(plainCalls[0]![1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('同時送的人數有上限', async () => {
    let inFlight = 0
    let peak = 0
    pushMock.mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 1))
      inFlight--
      return {}
    })

    const res = await pushMessagesPerRecipient(people(30), build, 'w1', { concurrency: 5, sleep: noSleep })

    expect(res.successCount).toBe(30)
    expect(peak).toBeLessThanOrEqual(5)
  })
})
