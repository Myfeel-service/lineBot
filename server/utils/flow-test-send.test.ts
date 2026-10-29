import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `C-426`：機器人模組「傳給我自己看」。
 *
 * 這一組釘三個承諾：
 *   ① **送的是畫面上那一份、而且不存檔**——模組一存檔就對客人生效，「先存再試」等於先上線再看。
 *   ② **存不了的也不送**——照樣走存檔那一套檢查，不然手機上看到的是存不進去的東西。
 *   ③ **收件人規則跟推播試發同一份**——名單外的人不送，看稿的同事點了不被貼標籤。
 */

const WS = 'ws1'
const ME = 'U0123456789abcdef0123456789abcdef'
const STRANGER = 'U2222222222abcdef0123456789abcdef'

vi.mock('~~/server/utils/firebase', () => ({ getDoc: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff1' })),
}))
vi.mock('~~/server/utils/handler', () => ({ renderFlowMessagesForSend: vi.fn() }))
vi.mock('~~/server/utils/line', () => ({ pushMessage: vi.fn() }))
vi.mock('~~/server/utils/broadcast-test-recipients', () => ({ allowedTestRecipientIds: vi.fn() }))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn() }))

let body: Record<string, unknown> = {}
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('useRuntimeConfig', () => ({ clickTrackingBaseUrl: 'https://example.com' }))
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { flowTestSend } = await import('./flow-test-send')
const { getDoc } = await import('~~/server/utils/firebase')
const { renderFlowMessagesForSend } = await import('~~/server/utils/handler')
const { pushMessage } = await import('~~/server/utils/line')
const { allowedTestRecipientIds } = await import('~~/server/utils/broadcast-test-recipients')
const { writeAuditLog } = await import('~~/server/utils/audit-log')
const mockGetDoc = vi.mocked(getDoc)
const mockRender = vi.mocked(renderFlowMessagesForSend)
const mockPush = vi.mocked(pushMessage)
const mockAllowed = vi.mocked(allowedTestRecipientIds)
const mockAudit = vi.mocked(writeAuditLog)

const DRAFT = [{ type: 'text', text: '嗨 {{displayName}}，這是還沒存的版本', buttons: [] }]
const send = () => flowTestSend({} as any)

beforeEach(() => {
  body = { messages: DRAFT, lineUserIds: [ME], name: '出貨進度' }
  mockGetDoc.mockReset()
  mockGetDoc.mockResolvedValue({ displayName: '吉米' } as any)
  mockRender.mockReset()
  mockRender.mockImplementation(async (messages: any[]) => ({
    hydratedMessages: messages,
    renderFor: (attrs: Record<string, string>) => messages.map(m => ({ type: 'text', text: String(m.text).replace('{{displayName}}', attrs.displayName ?? '') })),
  }) as any)
  mockPush.mockReset()
  mockAllowed.mockReset()
  mockAllowed.mockResolvedValue(new Set([ME]))
  mockAudit.mockReset()
})

describe('傳給我自己看：送畫面上那一份', () => {
  it('⭐ 送的是 body 帶來的草稿（不是資料庫裡存的），名字換成收件人自己的', async () => {
    const res = await send()

    expect(mockRender).toHaveBeenCalledWith(DRAFT, { workspaceId: WS, requestOrigin: 'https://example.com' })
    expect(mockPush).toHaveBeenCalledTimes(1)
    const [to, messages, ws] = mockPush.mock.calls[0]!
    expect(to).toBe(ME)
    expect(ws).toBe(WS)
    expect(messages).toEqual([{ type: 'text', text: '嗨 吉米，這是還沒存的版本' }])
    expect(res).toMatchObject({ ok: true, messageCount: 1, sent: [{ lineUserId: ME, displayName: '吉米', ok: true }] })
  })

  it('⛔ 不帶貼標連結：組訊息時不傳收件人的 userId（看稿的同事點了不該被貼標籤）', async () => {
    await send()
    const opts = mockRender.mock.calls[0]![1] as Record<string, unknown>
    expect(opts.userId).toBeUndefined()
  })

  it('送到才記操作紀錄，記收件人跟則數、不記內容', async () => {
    await send()
    expect(mockAudit).toHaveBeenCalledTimes(1)
    const row = mockAudit.mock.calls[0]![0] as any
    expect(row.action).toBe('flow.testSend')
    expect(row.after).toMatchObject({ name: '出貨進度', recipientNames: '吉米', recipientCount: 1, messagesCount: 1 })
    expect(JSON.stringify(row)).not.toContain('還沒存的版本')
  })
})

describe('存不了的不送', () => {
  it('⛔ 快速回覆不在最後一則：跟存檔一樣擋下，一則都沒送', async () => {
    body = {
      ...body,
      messages: [
        { type: 'quickReply', text: '想看哪一類？', quickReplies: [{ action: { type: 'message', label: '新品', text: '新品' } }] },
        { type: 'text', text: '後面還有一則' },
      ],
    }
    await expect(send()).rejects.toThrow(/快速回覆要放在最後一則/)
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('⛔ 一則都沒有：擋下', async () => {
    body = { ...body, messages: [] }
    await expect(send()).rejects.toThrow(/至少新增一則/)
    expect(mockPush).not.toHaveBeenCalled()
  })
})

describe('收件人：跟推播試發同一份規則', () => {
  it('⛔ 名單外的人（客人）：403，一則都沒送', async () => {
    body = { ...body, lineUserIds: [STRANGER] }
    await expect(send()).rejects.toMatchObject({ statusCode: 403 })
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('已經不是好友：講出是誰、為什麼，不記操作紀錄', async () => {
    mockGetDoc.mockResolvedValue(null as any)
    await expect(send()).rejects.toThrow(/已經不是這個官方帳號的好友/)
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })
})
