import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 兩種「記下來了」的答錯標記，誰看得到、誰收得掉（`D-136`）。
 * ⛔ 店家管理員只收自己工作區的「交給真人」；「AI 弄錯了」只有超管收（跨工作區，要我們修系統）。
 */

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn(() => db) }))
vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: 'ws1', uid: 'admin-1' })),
  requireSuperAdmin: vi.fn(async () => ({ uid: 'super-1' })),
}))
vi.mock('~~/server/utils/ai-feedback-events', async orig => ({
  ...(await orig<typeof import('~~/server/utils/ai-feedback-events')>()),
  markFeedbackHandled: vi.fn(async () => true),
}))

let method = 'GET'
let body: Record<string, unknown> = {}
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getMethod', () => method)
vi.stubGlobal('readBody', async () => body)
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const ROWS = [
  { id: 'h1', data: { type: 'wrong_answer', reason: 'should_handoff', query: '請問有進行退款了嗎？', createdAt: { toMillis: () => Date.now() - 3600_000 } } },
  { id: 'h2', data: { type: 'wrong_answer', reason: 'should_handoff', query: '已處理的', createdAt: { toMillis: () => Date.now() }, handledAt: { seconds: 1 } } },
  { id: 'm1', data: { type: 'wrong_answer', reason: 'ai_mistake', query: '我的會什麼時候出貨', createdAt: { toMillis: () => Date.now() } } },
]
const db = {
  collection: () => {
    const q = { where: () => q, orderBy: () => q, limit: () => q, get: async () => ({ docs: ROWS.map(r => ({ id: r.id, data: () => r.data })) }) }
    return q
  },
}

const { default: handler } = await import('./feedback-marks')
const { requireCapability, requireSuperAdmin } = await import('~~/server/utils/workspace-auth')
const { markFeedbackHandled } = await import('~~/server/utils/ai-feedback-events')
const call = () => (handler as unknown as (e: unknown) => Promise<any>)({})

beforeEach(() => {
  vi.clearAllMocks()
  method = 'GET'
  body = {}
})

describe('/api/ai/feedback-marks', () => {
  it('GET：只列「交給真人」、還沒處理的（AI 弄錯了不在店家這邊）；要改得動 AI 設定的人', async () => {
    const res = await call()
    expect(res.items.map((i: { id: string }) => i.id)).toEqual(['h1'])
    expect(requireCapability).toHaveBeenCalledWith(expect.anything(), 'ai.settings.write')
  })

  it('POST 交給真人：店家管理員、只收自己工作區的', async () => {
    method = 'POST'
    body = { reason: 'should_handoff', ids: ['h1'] }
    await expect(call()).resolves.toEqual({ ok: true, handled: 1 })
    expect(markFeedbackHandled).toHaveBeenCalledWith(db, 'h1', { reason: 'should_handoff', uid: 'admin-1', workspaceId: 'ws1' })
    expect(requireSuperAdmin).not.toHaveBeenCalled()
  })

  it('🔴 POST AI 弄錯了：只有超管（跨工作區、不比對工作區）', async () => {
    method = 'POST'
    body = { reason: 'ai_mistake', ids: ['m1'] }
    await call()
    expect(requireSuperAdmin).toHaveBeenCalled()
    expect(requireCapability).not.toHaveBeenCalled()
    expect(markFeedbackHandled).toHaveBeenCalledWith(db, 'm1', { reason: 'ai_mistake', uid: 'super-1' })
  })

  it('🔴 超管檢查不過 → 擋下、一筆都不收', async () => {
    vi.mocked(requireSuperAdmin).mockRejectedValueOnce(Object.assign(new Error('Super admin only'), { statusCode: 403 }))
    method = 'POST'
    body = { reason: 'ai_mistake', ids: ['m1'] }
    await expect(call()).rejects.toMatchObject({ statusCode: 403 })
    expect(markFeedbackHandled).not.toHaveBeenCalled()
  })

  it('原因不是這兩種（例如想收「資料寫錯」的待辦）、沒帶 ids → 400', async () => {
    method = 'POST'
    body = { reason: 'wrong_data', ids: ['x'] }
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })
    body = { reason: 'should_handoff', ids: [] }
    await expect(call()).rejects.toMatchObject({ statusCode: 400 })
    expect(markFeedbackHandled).not.toHaveBeenCalled()
  })
})
