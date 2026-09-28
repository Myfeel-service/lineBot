import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 轉真人清單的「失敗原因」只回給超管（`G-103`）。
 * 🔴 畫面只在超管勾「顯示技術細節」時才印，但 API 原本回給所有角色——
 *    那是外部服務的錯誤原文，觀察者開 DevTools 就看得到。
 */

vi.mock('~~/server/utils/firebase', () => ({ getDb: vi.fn() }))
vi.mock('~~/server/utils/workspace-auth', () => ({ requireWorkspaceAccess: vi.fn() }))
vi.mock('~~/server/utils/ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks' }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getQuery', () => ({}))

const { default: handler } = await import('./handoffs.get')
const { getDb } = await import('~~/server/utils/firebase')
const { requireWorkspaceAccess } = await import('~~/server/utils/workspace-auth')

const ts = (ms: number) => ({ toMillis: () => ms })

beforeEach(() => {
  const doc = {
    id: 'w1_Uc1',
    data: () => ({
      userId: 'Uc1',
      displayName: '客人',
      aiMeta: {
        lastDecision: 'handoff',
        lastHandoffReason: 'llm_error',
        lastQuery: '運費多少',
        lastConfidence: 0,
        lastErrorDetail: '429 RESOURCE_EXHAUSTED quota project 1234',
        updatedAt: ts(2000),
      },
    }),
  }
  const chain: any = { where: () => chain, orderBy: () => chain, limit: () => chain, get: async () => ({ size: 1, docs: [doc] }) }
  vi.mocked(getDb).mockReturnValue({ collection: () => chain, getAll: async () => [] } as never)
})

describe('GET /api/ai/usage/handoffs', () => {
  it('🔴 不是超管：列照給，失敗原因原文整格不出現', async () => {
    for (const role of ['viewer', 'agent', 'admin', 'owner'] as const) {
      vi.mocked(requireWorkspaceAccess).mockResolvedValueOnce({ workspaceId: 'w1', role, isSuperAdmin: false } as never)
      const res = await (handler as any)({})
      expect(res.rows, role).toHaveLength(1)
      expect(res.rows[0].lastQuery).toBe('運費多少')
      expect('errorDetail' in res.rows[0], role).toBe(false)
      expect(JSON.stringify(res), role).not.toContain('RESOURCE_EXHAUSTED')
    }
  })

  it('超管：照給（沒有它，事後連我們自己都查不出是哪一種失敗）', async () => {
    vi.mocked(requireWorkspaceAccess).mockResolvedValueOnce({ workspaceId: 'w1', role: 'owner', isSuperAdmin: true } as never)
    const res = await (handler as any)({})
    expect(res.rows[0].errorDetail).toBe('429 RESOURCE_EXHAUSTED quota project 1234')
  })
})
