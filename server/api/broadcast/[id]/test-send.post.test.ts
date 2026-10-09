import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `C-248`：先發一則給自己看。
 *
 * 這一組釘的是三個承諾，每一個都是「不釘就會悄悄變質」的那種：
 *   ① **內容跟正式發送同一份**——模組型送的是模組裡那幾則，不是那張會被換掉的卡。
 *      另外組一份的話，試發過了正式發送還是可能不一樣，那就白試了。
 *   ② **不動任何帳**——不改推播狀態、不貼記號、不寫成效。試發留下痕跡，成效報表就開始說謊。
 *   ③ **擋不住的事要講人話**——ID 貼錯、對方不是好友，都要在我們這邊講清楚，
 *      不要把 LINE 的 400 原封不動丟給店家。
 */

const WS = 'ws1'
const FRIEND = 'U0123456789abcdef0123456789abcdef'

vi.mock('~~/server/utils/firebase', () => ({ getDoc: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS })),
}))
vi.mock('~~/server/utils/handler', () => ({ renderModuleToLineMessages: vi.fn() }))
vi.mock('~~/server/utils/line', () => ({ pushMessage: vi.fn() }))
// `D-119` ⑥：只能發給試發名單上的人。名單怎麼算在 broadcast-test-recipients 那支測，這裡只給結果
vi.mock('~~/server/utils/broadcast-test-recipients', () => ({ allowedTestRecipientIds: vi.fn() }))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'bc1')
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('useRuntimeConfig', () => ({ clickTrackingBaseUrl: 'https://example.com' }))
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./test-send.post')
const { getDoc } = await import('~~/server/utils/firebase')
const { renderModuleToLineMessages } = await import('~~/server/utils/handler')
const { pushMessage } = await import('~~/server/utils/line')
const { allowedTestRecipientIds } = await import('~~/server/utils/broadcast-test-recipients')
const mockGetDoc = vi.mocked(getDoc)
const mockRender = vi.mocked(renderModuleToLineMessages)
const mockPush = vi.mocked(pushMessage)
const mockAllowed = vi.mocked(allowedTestRecipientIds)
/** 名單上的第二位（看稿的同事）、名單外的一位（客人） */
const COLLEAGUE = 'U1111111111abcdef0123456789abcdef'
const STRANGER = 'U2222222222abcdef0123456789abcdef'

const moduleCard = [{
  type: 'template',
  altText: '有一則訊息',
  template: {
    type: 'buttons',
    text: '點下面的按鈕看看',
    actions: [{ type: 'postback', label: '開始', data: 'triggerModule=mod_abc' }],
  },
}]

/** getDoc 會被叫兩次：先撈推播、再撈那位好友 */
function docsReturn(broadcast: Record<string, any> | null, friend: Record<string, any> | null) {
  mockGetDoc.mockImplementation(async (collection: string) => {
    if (collection === 'broadcasts') return broadcast as any
    if (collection === 'users') return friend as any
    return null as any
  })
}

beforeEach(() => {
  body = { lineUserId: FRIEND }
  mockGetDoc.mockReset()
  mockRender.mockReset()
  mockPush.mockReset()
  mockAllowed.mockReset()
  mockAllowed.mockResolvedValue(new Set([FRIEND, COLLEAGUE]))
})

describe('試發一則：送的是正式發送會送的那一份', () => {
  it('⭐ 模組型：送出模組裡那幾則，那張卡不會出現', async () => {
    docsReturn({ workspaceId: WS, messages: moduleCard }, { displayName: '吉米' })
    mockRender.mockResolvedValue({
      flow: { name: '開賣通知' },
      lineMessages: [{ type: 'imagemap' }, { type: 'text', text: '開賣了' }],
      hydratedMessages: [],
    } as any)

    const res = await (handler as any)({})

    expect(mockPush).toHaveBeenCalledTimes(1)
    const [to, messages, ws] = mockPush.mock.calls[0]!
    expect(to).toBe(FRIEND)
    expect(ws).toBe(WS)
    expect(JSON.stringify(messages)).not.toContain('點下面的按鈕看看')
    expect(res).toMatchObject({ ok: true, messageCount: 2, moduleName: '開賣通知', sent: [{ lineUserId: FRIEND, displayName: '吉米', ok: true }] })
  })

  it('純文字：照原樣送（送出端也不會動它）', async () => {
    docsReturn({ workspaceId: WS, messages: [{ type: 'text', text: '今天公休' }] }, { displayName: '吉米' })

    const res = await (handler as any)({})

    expect(mockRender).not.toHaveBeenCalled()
    expect(mockPush.mock.calls[0]![1]).toEqual([{ type: 'text', text: '今天公休' }])
    expect(res.messageCount).toBe(1)
  })

  it('⛔ 不是 LINE 帳號的編號 → 擋下來，不要讓 LINE 回一個看不懂的 400', async () => {
    docsReturn({ workspaceId: WS, messages: [{ type: 'text', text: 'hi' }] }, { displayName: '吉米' })
    body = { lineUserId: 'Uf0d' }

    await expect((handler as any)({})).rejects.toThrow(/不是 LINE 帳號/)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('⛔ 對方不是這個官方帳號的好友 → 講出「LINE 只讓我們發給已加好友的人」', async () => {
    docsReturn({ workspaceId: WS, messages: [{ type: 'text', text: 'hi' }] }, null)

    await expect((handler as any)({})).rejects.toThrow(/好友/)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('⛔ 模組壞掉 → 直接講「正式發送也會失敗」，不要等他發出去才知道', async () => {
    docsReturn({ workspaceId: WS, messages: moduleCard }, { displayName: '吉米' })
    mockRender.mockResolvedValue(null as any)

    await expect((handler as any)({})).rejects.toThrow(/正式發送也會失敗/)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('⛔ 別的官方帳號的推播一律 404（多租戶）', async () => {
    docsReturn({ workspaceId: 'ws2', messages: [{ type: 'text', text: 'hi' }] }, { displayName: '吉米' })

    await expect((handler as any)({})).rejects.toThrow('Broadcast not found')
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('⛔ LINE 不收 → 502 並帶上原因（常見是對方封鎖了官方帳號）', async () => {
    docsReturn({ workspaceId: WS, messages: [{ type: 'text', text: 'hi' }] }, { displayName: '吉米' })
    mockPush.mockRejectedValue(Object.assign(new Error('boom'), {
      originalError: { response: { data: { message: 'You cannot send messages to this user' } } },
    }))

    await expect((handler as any)({})).rejects.toThrow(/封鎖/)
  })
})

/**
 * `D-119` ⑥（2026-10-09 老闆「照改」）：只能發給試發名單上的人，一次可以好幾位。
 * 為什麼：原本在九千多位好友裡搜名字，叫 Alice 的有 5 位，挑錯就是把還沒定稿的內容發給客人；
 * 但又不能只限自己——正式庫裡被拿來試打的推播，大多是一次發給幾位看稿的同事。
 */
describe('試發只能發給名單上的人，一次可以好幾位', () => {
  /** 每位好友各自的資料（null＝不是好友了） */
  function friendsAre(map: Record<string, Record<string, any> | null>) {
    mockGetDoc.mockImplementation(async (collection: string, id: string) => {
      if (collection === 'broadcasts') return { workspaceId: WS, name: '水多會-超早鳥倒數', messages: [{ type: 'text', text: 'hi' }] } as any
      if (collection === 'users') return (Object.entries(map).find(([k]) => id.endsWith(k))?.[1] ?? null) as any
      return null as any
    })
  }

  it('⛔ 名單外的人（例如挑錯的同名客人）→ 403，而且一個都不送', async () => {
    friendsAre({ [FRIEND]: { displayName: '江' }, [STRANGER]: { displayName: 'Alice' } })
    body = { lineUserIds: [FRIEND, STRANGER] }

    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 403 })
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('⭐ 一次好幾位：一位封鎖了，其他照送，回傳講得出誰沒送到', async () => {
    friendsAre({ [FRIEND]: { displayName: '江' }, [COLLEAGUE]: { displayName: '游瑞茹' } })
    mockPush.mockImplementation(async (to: string) => {
      if (to === COLLEAGUE) throw Object.assign(new Error('boom'), { originalError: { response: { data: { message: 'blocked' } } } })
      return {} as Awaited<ReturnType<typeof pushMessage>>
    })
    body = { lineUserIds: [FRIEND, COLLEAGUE] }

    const res = await (handler as any)({})

    expect(mockPush).toHaveBeenCalledTimes(2)
    expect(res.sent).toEqual([
      { lineUserId: FRIEND, displayName: '江', ok: true },
      expect.objectContaining({ lineUserId: COLLEAGUE, displayName: '游瑞茹', ok: false, error: expect.stringContaining('封鎖') }),
    ])
  })

  it('一位都沒送到 → 整個算失敗，講出每一位的原因', async () => {
    friendsAre({ [FRIEND]: null, [COLLEAGUE]: { displayName: '游瑞茹' } })
    mockPush.mockRejectedValue(new Error('boom'))
    body = { lineUserIds: [FRIEND, COLLEAGUE] }

    await expect((handler as any)({})).rejects.toThrow(/一位都沒送到.*不是這個官方帳號的好友.*游瑞茹/)
  })

  it('一個都沒勾 → 講要勾人，不要送', async () => {
    friendsAre({ [FRIEND]: { displayName: '江' } })
    body = { lineUserIds: [] }

    await expect((handler as any)({})).rejects.toThrow(/至少勾一位/)
    expect(mockPush).not.toHaveBeenCalled()
  })
})
