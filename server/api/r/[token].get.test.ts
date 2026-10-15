import { beforeEach, describe, expect, it, vi } from 'vitest'
import { wrapBroadcastMessagesForClickTracking } from '~~/server/utils/broadcast-click-track'
import { createUriTagToken } from '~~/server/utils/line-action-tag-token'
import { encodeTriggerModule } from '~~/shared/action-schema'

/**
 * 推播點擊轉址（`G-95`）。token 沒有簽章——⛔ 也不能補簽章（已經發出去的連結收不回來），
 * 所以改成拿推播本身比對目標網址。釘的是：
 * 1. **真的包過的舊連結照樣能用、照樣記點擊**（用真的包裝函式產生 token，不手寫）
 * 2. 偽造的目標、不存在的推播、從沒送過的草稿 → 回首頁、⛔ 一筆都不記
 * 3. 模組型：更早送出（沒有 sentContent）的，拿模組現在的內容重組來比
 */

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/handler', () => ({
  renderModuleToLineMessages: vi.fn(async () => null),
  // 送出端產生貼標連結用的網域＝點擊追蹤的網域（跟正式設定一樣）
  resolveLineImagemapPublicBase: (fallback: string) => fallback,
}))
vi.mock('~~/server/utils/line-workspace-credentials', () => ({
  getLineWorkspaceCredentials: vi.fn(async (ws: string) => ({ channelSecret: `secret-${ws}` })),
}))
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__ts__' } }))

let tokenParam = ''
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => tokenParam)
vi.stubGlobal('sendRedirect', (_e: unknown, to: string) => ({ redirectTo: to }))
vi.stubGlobal('useRuntimeConfig', () => ({ clickTrackingBaseUrl: 'https://app.example.com' }))

const { default: handler } = await import('./[token].get')
const { getDb } = await import('~~/server/utils/firebase')
const { renderModuleToLineMessages } = await import('~~/server/utils/handler')

const ORIGIN = 'https://app.example.com'
const shopButton = [{ type: 'template', altText: 'x', template: { type: 'buttons', text: 't', actions: [
  { type: 'uri', label: '去逛逛', uri: 'https://shop.example.com/sale' },
] } }]

let broadcasts: Record<string, Record<string, unknown>> = {}
const logs: Record<string, unknown>[] = []

beforeEach(() => {
  logs.length = 0
  broadcasts = {}
  vi.mocked(renderModuleToLineMessages).mockReset().mockResolvedValue(null)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(getDb).mockReturnValue({
    collection: (name: string) => ({
      doc: (id: string) => {
        if (id.includes('/')) throw new Error('documentPath must point to a document')
        return {
          get: async () => ({ exists: name === 'broadcasts' && !!broadcasts[id], data: () => broadcasts[id] }),
          set: async (d: Record<string, unknown>) => { logs.push(d) },
        }
      },
    }),
  } as never)
})

/** 用送出端真的包裝函式產生連結，再取出 token（⛔ 不手寫 token：手寫的跟真的漂開就測不到） */
function realTokenFor(messages: unknown[], campaignId: string): string {
  const wrapped = JSON.stringify(wrapBroadcastMessagesForClickTracking(messages, campaignId, ORIGIN))
  const m = wrapped.match(/https:\/\/app\.example\.com\/api\/r\/([\w-]+)/)
  return m![1]!
}
const forgedToken = (campaignId: string, target: string) =>
  Buffer.from([campaignId, '', '', 'tpl_buttons_0', target].join('|'), 'utf-8').toString('base64url')

const call = (token: string) => {
  tokenParam = token
  return (handler as unknown as (e: unknown) => Promise<{ redirectTo: string }>)({})
}

describe('GET /api/r/:token', () => {
  it('⭐ 已經發出去的連結照樣能用：轉到原網址、記一筆點擊（欄位跟以前一樣）', async () => {
    broadcasts.b1 = { workspaceId: 'ws1', status: 'completed', messages: shopButton }
    await expect(call(realTokenFor(shopButton, 'b1'))).resolves.toEqual({ redirectTo: 'https://shop.example.com/sale' })
    expect(logs).toEqual([{
      workspaceId: 'ws1', campaignId: 'b1', deliveryId: null, userId: null,
      linkKey: 'tpl_buttons_0', targetUrl: 'https://shop.example.com/sale', clickedAt: '__ts__',
    }])
  })

  it('🔴 拿真的推播 id 配上釣魚網址 → 回首頁、不記', async () => {
    broadcasts.b1 = { workspaceId: 'ws1', status: 'completed', messages: shopButton }
    await expect(call(forgedToken('b1', 'https://evil.example.com/login'))).resolves.toEqual({ redirectTo: '/' })
    expect(logs).toHaveLength(0)
  })

  it('🔴 不存在的推播 → 回首頁、不記（以前會記一筆 workspaceId 空白的點擊）', async () => {
    await expect(call(forgedToken('nope', 'https://shop.example.com/sale'))).resolves.toEqual({ redirectTo: '/' })
    await expect(call(forgedToken('a/b', 'https://shop.example.com/sale'))).resolves.toEqual({ redirectTo: '/' })
    expect(logs).toHaveLength(0)
  })

  it('🔴 從沒送出過的草稿 → 回首頁（⛔ 不然建一則草稿就能自己組轉址連結）', async () => {
    broadcasts.d1 = { workspaceId: 'ws1', status: 'draft', messages: shopButton }
    await expect(call(realTokenFor(shopButton, 'd1'))).resolves.toEqual({ redirectTo: '/' })
    expect(logs).toHaveLength(0)
  })

  it('模組型、沒有 sentContent（`C-246` 以前送的）：拿模組現在的內容重組來比', async () => {
    const card = [{ type: 'template', altText: 'x', template: { type: 'buttons', text: 't', actions: [
      { type: 'postback', label: '開始', data: encodeTriggerModule('mod1', []) },
    ] } }]
    broadcasts.m1 = { workspaceId: 'ws1', status: 'completed', messages: card }
    const moduleLine = [{ type: 'template', altText: 'x', template: { type: 'buttons', text: 't', actions: [
      { type: 'uri', label: '報名', uri: 'https://form.example.com/join' },
    ] } }]
    vi.mocked(renderModuleToLineMessages).mockResolvedValue({ flow: {}, lineMessages: moduleLine, hydratedMessages: [] } as never)

    await expect(call(realTokenFor(moduleLine, 'm1'))).resolves.toEqual({ redirectTo: 'https://form.example.com/join' })
    expect(renderModuleToLineMessages).toHaveBeenCalledWith('mod1', { workspaceId: 'ws1', requestOrigin: ORIGIN })
    await expect(call(forgedToken('m1', 'https://evil.example.com'))).resolves.toEqual({ redirectTo: '/' })
    // 第二次走快取，⛔ 不會每點一次就重組一次模組
    expect(renderModuleToLineMessages).toHaveBeenCalledTimes(1)
    expect(logs).toHaveLength(1)
  })

  it('非 http 目標、壞掉的 token → 回首頁、不讀庫', async () => {
    await expect(call(forgedToken('b1', 'javascript:alert(1)'))).resolves.toEqual({ redirectTo: '/' })
    await expect(call('!!!')).resolves.toEqual({ redirectTo: '/' })
    expect(logs).toHaveLength(0)
  })
})

/**
 * `C-322`：推播一人一則送時，開了貼標的網址按鈕是那一位**專屬的貼標連結**（我們網域的 `/api/t/`），
 * 點擊追蹤再包一層。以前這裡拿它跟推播內容比一定對不上→回首頁（所以那時推播一律不貼標）。
 * 釘的是：真的貼標連結照樣轉、記**原網址**與那一位；網域、簽章、原網址任何一關不對都回首頁。
 */
describe('GET /api/r/:token — 推播裡的貼標連結', () => {
  const SALE = 'https://shop.example.com/sale'
  const tagLink = (opts: { secret?: string, target?: string, origin?: string, userId?: string } = {}) =>
    `${opts.origin ?? ORIGIN}/api/t/${encodeURIComponent(createUriTagToken({
      targetUrl: opts.target ?? SALE,
      userId: opts.userId ?? 'Uabc',
      tagIds: ['t-interested'],
    }, opts.secret ?? 'secret-ws1'))}`
  const withLink = (uri: string) => [{ type: 'template', altText: 'x', template: { type: 'buttons', text: 't', actions: [
    { type: 'uri', label: '去逛逛', uri },
  ] } }]

  it('⭐ 那一位的貼標連結：轉去貼標連結（由它貼標再轉原網址），點擊記原網址與那一位', async () => {
    broadcasts.b1 = { workspaceId: 'ws1', status: 'completed', messages: shopButton }
    const link = tagLink()

    await expect(call(realTokenFor(withLink(link), 'b1'))).resolves.toEqual({ redirectTo: link })
    expect(logs).toEqual([expect.objectContaining({ campaignId: 'b1', targetUrl: SALE, userId: 'Uabc' })])
  })

  it('過期的貼標連結（簽章還是我們的）照樣轉：到了貼標連結那邊只是不貼標', async () => {
    broadcasts.b1 = { workspaceId: 'ws1', status: 'completed', messages: shopButton }
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const old = tagLink()
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'))
    try {
      await expect(call(realTokenFor(withLink(old), 'b1'))).resolves.toEqual({ redirectTo: old })
    }
    finally { vi.useRealTimers() }
  })

  it('🔴 別的帳號簽的、裡面包的不是這則推播的網址、接在別人網域後面 → 一律回首頁、不記', async () => {
    broadcasts.b1 = { workspaceId: 'ws1', status: 'completed', messages: shopButton }
    for (const link of [
      tagLink({ secret: 'secret-ws2' }),
      tagLink({ target: 'https://evil.example.com/login' }),
      // ⚠️ 假網域刻意跟 ORIGIN 一樣長：長度不同的話，切 token 時就切歪了、因為別的原因被擋，
      //    等於沒驗到「網域要是我們的」這一關（第一版就是這樣拿掉網域檢查也照綠）
      tagLink({ origin: 'https://app.evilxyz.com' }),
    ]) {
      await expect(call(realTokenFor(withLink(link), 'b1'))).resolves.toEqual({ redirectTo: '/' })
    }
    expect(logs).toHaveLength(0)
  })
})
