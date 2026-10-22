import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const quotaMock = vi.fn()
const consumptionMock = vi.fn()
const pushMock = vi.fn()
const multicastStatsMock = vi.fn()
const pushStatsMock = vi.fn()
const replyStatsMock = vi.fn()

vi.mock('@line/bot-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line/bot-sdk')>()
  return {
    ...actual,
    messagingApi: {
      ...actual.messagingApi,
      MessagingApiClient: class {
        getMessageQuota = quotaMock
        getMessageQuotaConsumption = consumptionMock
        pushMessage = pushMock
        getNumberOfSentMulticastMessages = multicastStatsMock
        getNumberOfSentPushMessages = pushStatsMock
        getNumberOfSentReplyMessages = replyStatsMock
      },
      MessagingApiBlobClient: class {},
    },
  }
})
const { getLineWorkspaceCredentials } = vi.hoisted(() => ({
  getLineWorkspaceCredentials: vi.fn(async (_wid: string) => ({ channelAccessToken: 'token', channelSecret: 'secret' })),
}))
vi.mock('./line-workspace-credentials', () => ({ getLineWorkspaceCredentials }))

import { HTTPFetchError } from '@line/bot-sdk'
import { getLineMessageQuota, getLineMonthSendBreakdown, pushMessage, readLineMessageQuota, readLineMessageQuotaCached } from './line'

beforeEach(() => {
  quotaMock.mockReset()
  consumptionMock.mockReset()
  pushMock.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * `C-380`：推播頁左邊那一行與發送前確認都會順便問 LINE 剩幾則。
 * ⛔ 問不到不可以害清單或確認失敗：一律回 null（畫面整行不顯示），而且 LINE 慢的時候不能拖住端點。
 */
describe('getLineMessageQuota', () => {
  it('上限＋已送合成一份', async () => {
    quotaMock.mockResolvedValue({ type: 'limited', value: 3000 })
    consumptionMock.mockResolvedValue({ totalUsage: 210 })
    expect(await getLineMessageQuota('w1')).toEqual({ limit: 3000, used: 210, remaining: 2790 })
  })

  it('LINE 退件（憑證失效）→ null、留 log', async () => {
    quotaMock.mockRejectedValue(new HTTPFetchError('Request failed', {
      status: 401, statusText: '', headers: new Headers(), body: '{"message":"Authentication failed"}',
    }))
    consumptionMock.mockResolvedValue({ totalUsage: 1 })
    expect(await getLineMessageQuota('w1')).toBeNull()
    expect(console.warn).toHaveBeenCalled()
  })

  it('還沒接 LINE（沒有憑證）→ null', async () => {
    getLineWorkspaceCredentials.mockResolvedValueOnce({ channelAccessToken: '', channelSecret: '' })
    expect(await getLineMessageQuota('w-no-line')).toBeNull()
    expect(quotaMock).not.toHaveBeenCalled()
  })

  it('⭐ LINE 一直不回 → 4 秒就放棄回 null，不拖住呼叫它的端點', async () => {
    vi.useFakeTimers()
    quotaMock.mockReturnValue(new Promise(() => {}))
    consumptionMock.mockResolvedValue({ totalUsage: 1 })
    const p = getLineMessageQuota('w1')
    await vi.advanceTimersByTimeAsync(4000)
    expect(await p).toBeNull()
  })
})

const ok = (used: number, limit = 3000) => {
  quotaMock.mockResolvedValue({ type: 'limited', value: limit })
  consumptionMock.mockResolvedValue({ totalUsage: used })
}
const http = (status: number, message: string) => new HTTPFetchError('Request failed', {
  status, statusText: '', headers: new Headers(), body: JSON.stringify({ message }),
})

/**
 * `D-146`：小幫手要分得出「沒接 LINE（不亮）」跟「問不到（這次查不到）」——⛔ 問不到不等於沒事。
 */
describe('readLineMessageQuota：三種結果分開講', () => {
  it('問到了 → ok', async () => {
    ok(210)
    expect(await readLineMessageQuota('w-ok')).toEqual({ kind: 'ok', quota: { limit: 3000, used: 210, remaining: 2790 } })
  })

  it('沒接 LINE → unconfigured（不去問 LINE）', async () => {
    getLineWorkspaceCredentials.mockResolvedValueOnce({ channelAccessToken: '', channelSecret: '' })
    expect(await readLineMessageQuota('w-none')).toEqual({ kind: 'unconfigured' })
    expect(quotaMock).not.toHaveBeenCalled()
  })

  it('⭐ LINE 退件 → error（⛔ 不是 unconfigured、不是 null）', async () => {
    quotaMock.mockRejectedValue(http(401, 'Authentication failed'))
    consumptionMock.mockResolvedValue({ totalUsage: 1 })
    expect((await readLineMessageQuota('w-err')).kind).toBe('error')
  })
})

/**
 * 登入後第一頁那一條、每一頁紅條、小幫手都會問：5 分鐘內同一個帳號只問 LINE 一次；
 * 但送東西被 LINE 擋下「這個月用完了」要當場丟掉快取，紅色不用等 5 分鐘。
 */
describe('readLineMessageQuotaCached', () => {
  it('5 分鐘內不重問；skipCache 照問', async () => {
    ok(100)
    await readLineMessageQuotaCached('w-cache')
    await readLineMessageQuotaCached('w-cache')
    expect(quotaMock).toHaveBeenCalledTimes(1)
    await readLineMessageQuotaCached('w-cache', { skipCache: true })
    expect(quotaMock).toHaveBeenCalledTimes(2)
  })

  it('問失敗不記：下一次照問', async () => {
    quotaMock.mockRejectedValueOnce(http(500, 'oops'))
    consumptionMock.mockResolvedValue({ totalUsage: 1 })
    expect((await readLineMessageQuotaCached('w-fail')).kind).toBe('error')
    quotaMock.mockResolvedValue({ type: 'limited', value: 3000 })
    expect((await readLineMessageQuotaCached('w-fail')).kind).toBe('ok')
    expect(quotaMock).toHaveBeenCalledTimes(2)
  })

  it('⭐ 推送被 LINE 擋下「這個月用完了」→ 丟掉快取，下一次問就是新的', async () => {
    ok(2990)
    await readLineMessageQuotaCached('w-reject')
    pushMock.mockRejectedValue(http(429, 'You have reached your monthly limit.'))
    await expect(pushMessage('U1', [{ type: 'text', text: 'hi' }], 'w-reject')).rejects.toBeTruthy()
    ok(3000)
    const r = await readLineMessageQuotaCached('w-reject')
    expect(quotaMock).toHaveBeenCalledTimes(2)
    expect(r).toEqual({ kind: 'ok', quota: { limit: 3000, used: 3000, remaining: 0 } })
  })

  it('對照組：送太快被擋（也是 429）不丟快取', async () => {
    ok(10)
    await readLineMessageQuotaCached('w-rate')
    pushMock.mockRejectedValue(http(429, 'The API rate limit has been exceeded.'))
    await expect(pushMessage('U1', [{ type: 'text', text: 'hi' }], 'w-rate')).rejects.toBeTruthy()
    await readLineMessageQuotaCached('w-rate')
    expect(quotaMock).toHaveBeenCalledTimes(1)
  })
})

/** 問小幫手「LINE 還剩幾則」時順便講這個月用在哪 */
describe('getLineMonthSendBreakdown', () => {
  beforeEach(() => {
    multicastStatsMock.mockReset()
    pushStatsMock.mockReset()
    replyStatsMock.mockReset()
  })

  it('這個月 1 號到昨天（日本時間）逐日加總；LINE 不給數字的天照實數', async () => {
    multicastStatsMock.mockImplementation(async (d: string) => (d === '20261004' ? { status: 'ready', success: 3756 } : { status: 'ready', success: 0 }))
    pushStatsMock.mockImplementation(async (d: string) => (d === '20261003' ? { status: 'unavailable_for_privacy' } : { status: 'ready', success: 10 }))
    replyStatsMock.mockResolvedValue({ status: 'ready', success: 5 })
    // 日本時間 10/5 01:00＝台灣 10/5 00:00 → 算 10/1～10/4
    const r = await getLineMonthSendBreakdown('w-stats', Date.parse('2026-10-05T01:00:00+09:00'))
    expect(multicastStatsMock).toHaveBeenCalledTimes(4)
    expect(r).toEqual({ multicast: 3756, push: 30, reply: 20, throughLabel: '10/4', missingDays: 1 })
  })

  it('1 號當天：還沒有任何一天可以查', async () => {
    const r = await getLineMonthSendBreakdown('w-stats', Date.parse('2026-11-01T12:00:00+09:00'))
    expect(r).toEqual({ multicast: 0, push: 0, reply: 0, throughLabel: null, missingDays: 0 })
    expect(multicastStatsMock).not.toHaveBeenCalled()
  })

  it('問不到 → null', async () => {
    multicastStatsMock.mockRejectedValue(http(500, 'oops'))
    pushStatsMock.mockResolvedValue({ status: 'ready', success: 1 })
    replyStatsMock.mockResolvedValue({ status: 'ready', success: 1 })
    expect(await getLineMonthSendBreakdown('w-stats', Date.parse('2026-10-05T01:00:00+09:00'))).toBeNull()
  })
})
