import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const quotaMock = vi.fn()
const consumptionMock = vi.fn()

vi.mock('@line/bot-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line/bot-sdk')>()
  return {
    ...actual,
    messagingApi: {
      ...actual.messagingApi,
      MessagingApiClient: class {
        getMessageQuota = quotaMock
        getMessageQuotaConsumption = consumptionMock
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
import { getLineMessageQuota } from './line'

beforeEach(() => {
  quotaMock.mockReset()
  consumptionMock.mockReset()
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
