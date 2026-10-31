import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 改模組端點的操作紀錄（`C-411`）：只改了訊息內容、則數沒變，以前一筆都不寫。
 * 寫的東西只到「改了第幾則」，⛔ 不存內容；什麼都沒改照舊不寫。
 */

const WS = 'ws1'

vi.mock('~~/server/utils/firebase', () => ({ getDoc: vi.fn(), updateDoc: vi.fn(async () => {}), getDb: vi.fn(() => ({})) }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: WS, uid: 'u1', role: 'admin' })),
}))
vi.mock('~~/server/utils/billing', () => ({ assertPlanAllows: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/broken-module-refs', () => ({ invalidateBrokenModuleRefsCache: vi.fn() }))
vi.mock('~~/server/utils/sheet-field-hydrate', () => ({ attachSheetSnapshots: vi.fn(async (m: unknown) => m) }))
vi.mock('~~/server/utils/sheet-catalog', () => ({ configureSheetCatalogs: vi.fn(async () => {}) }))
vi.mock('~~/server/utils/audit-log', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  writeAuditLog: vi.fn(async () => {}),
}))

let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'f1')
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('updateDoc', vi.fn(async () => {}))
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) =>
  Object.assign(new Error(o.statusMessage ?? 'e'), o))

const { default: handler } = await import('./[id].put')
const { getDoc } = await import('~~/server/utils/firebase')
const { writeAuditLog } = await import('~~/server/utils/audit-log')

const run = () => (handler as (e: unknown) => Promise<unknown>)({})
const text = (t: string) => ({ type: 'text', text: t, buttons: [] })
const givenFlow = (doc: Record<string, unknown>) =>
  vi.mocked(getDoc).mockResolvedValue({ id: 'f1', workspaceId: WS, name: '出貨進度查詢', isActive: true, ...doc } as never)

beforeEach(() => {
  vi.mocked(getDoc).mockReset()
  vi.mocked(writeAuditLog).mockClear()
})

describe('PUT /api/flow/:id 操作紀錄', () => {
  it('⭐ 只改了第 2 則的字（則數沒變）：記一筆「訊息內容：原本的內容 → 第 2 則改過了」，⛔ 不存內容', async () => {
    givenFlow({ messages: [text('您好'), text('10 月底出貨')] })
    body = { messages: [text('您好'), text('11 月中出貨')] }
    await run()
    expect(writeAuditLog).toHaveBeenCalledTimes(1)
    const row = vi.mocked(writeAuditLog).mock.calls[0]![0] as any
    expect(row).toMatchObject({ action: 'flow.put', targetId: 'f1', before: { messagesEdited: '原本的內容' }, after: { messagesEdited: '第 2 則改過了' } })
    expect(JSON.stringify(row)).not.toContain('11 月中出貨')
    expect(JSON.stringify(row)).not.toContain('10 月底出貨')
  })

  it('什麼都沒改就存檔：照舊不寫', async () => {
    givenFlow({ messages: [text('您好')] })
    body = { messages: [text('您好')] }
    await run()
    expect(writeAuditLog).not.toHaveBeenCalled()
  })

  it('只改名字：跟以前一樣只記名字（沒帶訊息不比）', async () => {
    givenFlow({ messages: [text('您好')] })
    body = { name: '新名字' }
    await run()
    const row = vi.mocked(writeAuditLog).mock.calls[0]![0] as any
    expect(row.before).toEqual({ name: '出貨進度查詢' })
    expect(row.after).toEqual({ name: '新名字' })
  })

  it('加了一則：記「訊息則數 1 → 2」，⛔ 不重複講「第 2 則改過了」', async () => {
    givenFlow({ messages: [text('您好')] })
    body = { messages: [text('您好'), text('新的')] }
    await run()
    const row = vi.mocked(writeAuditLog).mock.calls[0]![0] as any
    expect(row.after).toEqual({ messagesCount: 2 })
  })
})
