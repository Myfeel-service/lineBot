import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「我接手」自動指派負責人員（`H-41`，2026-09-29 權限盤點順手查到）。
 *
 * 🔴 session 存的 userId 是原始 LINE id，對話文件 id 是「帳號 id + LINE id」。
 *    原本直接拿 session.userId 當文件 id → 永遠讀不到、靜靜跳過（錯誤被 catch 吞掉），
 *    這個功能從上線起就沒生效過。
 */

const WS = 'ws1'
const LINE_UID = 'U0000000000000000000000000000001'

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'staff-1', token: { name: '客服小美' } })),
}))
vi.mock('~~/server/utils/conversation-session', () => ({
  enterModule: vi.fn(async () => {}),
  markHumanOwnership: vi.fn(async () => {}),
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'sess-1')
vi.stubGlobal('createError', (opts: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(opts.statusMessage ?? 'error'), opts))

const { default: handler } = await import('./takeover.post')
const { getDb } = await import('~~/server/utils/firebase')

let docs: Record<string, Record<string, Record<string, unknown>>> = {}
const updates: Array<{ col: string, id: string, data: any }> = []

beforeEach(() => {
  vi.clearAllMocks()
  updates.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  docs = {
    conversationSessions: { 'sess-1': { workspaceId: WS, userId: LINE_UID, status: 'open' } },
    conversations: { [`${WS}_${LINE_UID}`]: { workspaceId: WS } },
  }
  vi.mocked(getDb).mockReturnValue({
    collection: (col: string) => ({
      doc: (id: string) => ({
        get: async () => ({ exists: !!docs[col]?.[id], data: () => docs[col]?.[id] }),
        update: async (data: any) => { updates.push({ col, id, data }) },
      }),
    }),
  } as never)
})

const call = () => (handler as unknown as (e: unknown) => Promise<unknown>)({})

describe('POST /api/conversations/sessions/:sessionId/takeover', () => {
  it('🔴 按「我接手」的人被記成負責人員（session 存原始 LINE id，也要找得到對話文件）', async () => {
    await expect(call()).resolves.toEqual({ ok: true })
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      col: 'conversations',
      id: `${WS}_${LINE_UID}`,
      data: { assigneeUid: 'staff-1', assigneeName: '客服小美' },
    })
  })

  it('已經有人負責 → 不覆蓋', async () => {
    docs.conversations![`${WS}_${LINE_UID}`] = { workspaceId: WS, assigneeUid: 'staff-0' }
    await call()
    expect(updates).toHaveLength(0)
  })

  it('⛔ 對話文件不是這個帳號的 → 不指派，但接手本身照樣成功', async () => {
    docs.conversations![`${WS}_${LINE_UID}`] = { workspaceId: 'ws2' }
    await expect(call()).resolves.toEqual({ ok: true })
    expect(updates).toHaveLength(0)
  })
})
