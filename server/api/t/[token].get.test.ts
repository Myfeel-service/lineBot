import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUriTagToken } from '~~/server/utils/line-action-tag-token'

/**
 * 貼標連結（`/api/t/:token`）：點了先貼標、再轉去原網址。
 * `C-322`：推播一人一則送之後這種連結會在客人的聊天紀錄裡躺好幾週——過期（14 天）但簽章對得上的，
 * **照樣帶去原網址、只是不貼標**；⛔ 以前過期回首頁＝兩週前的推播按鈕點了就壞掉。
 */

vi.mock('~~/server/utils/tagging', () => ({ addTagsToUser: vi.fn(async () => ({ added: 1 })) }))
vi.mock('~~/server/utils/line-workspace-credentials', () => ({
  listWorkspaceLineCredentials: vi.fn(async () => [
    { workspaceId: 'ws2', credentials: { channelSecret: 'secret-ws2' } },
    { workspaceId: 'ws1', credentials: { channelSecret: 'secret-ws1' } },
  ]),
}))

let tokenParam = ''
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => tokenParam)
vi.stubGlobal('sendRedirect', (_e: unknown, to: string) => ({ redirectTo: to }))

const { default: handler } = await import('./[token].get')
const { addTagsToUser } = await import('~~/server/utils/tagging')

const SALE = 'https://shop.example.com/sale'
const UID = 'U4af4980629b8c1d2e3f4a5b6c7d8e9f0'
const tokenFor = (secret = 'secret-ws1') => createUriTagToken({ targetUrl: SALE, userId: UID, tagIds: ['t-interested'] }, secret)
const call = (token: string) => {
  tokenParam = token
  return (handler as unknown as (e: unknown) => Promise<{ redirectTo: string }>)({})
}

beforeEach(() => {
  vi.mocked(addTagsToUser).mockClear()
  vi.useRealTimers()
})

describe('GET /api/t/:token', () => {
  it('⭐ 有效的連結：幫那一位貼標（算在簽它的那個帳號），再轉去原網址', async () => {
    await expect(call(tokenFor())).resolves.toEqual({ redirectTo: SALE })
    expect(addTagsToUser).toHaveBeenCalledWith(`ws1_${UID}`, ['t-interested'], 'system', 'uri-click', 'ws1')
  })

  it('⭐ 過期但簽章對得上：照樣轉去原網址，⛔ 不貼標', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const old = tokenFor()
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'))

    await expect(call(old)).resolves.toEqual({ redirectTo: SALE })
    expect(addTagsToUser).not.toHaveBeenCalled()
  })

  it('🔴 簽章對不上（沒有任何一個帳號簽過）→ 回首頁、不貼標', async () => {
    await expect(call(tokenFor('secret-nobody'))).resolves.toEqual({ redirectTo: '/' })
    await expect(call('!!!')).resolves.toEqual({ redirectTo: '/' })
    expect(addTagsToUser).not.toHaveBeenCalled()
  })
})
