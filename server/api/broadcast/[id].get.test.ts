import { describe, expect, it, vi } from 'vitest'

/**
 * 推播的完整收件名單只給管理員（`D-111` 2026-09-29 拍板）。
 * `?withAudienceIds=1` 原本觀察者帶了就拿得到每位客人的 LINE id；前端沒有任何地方帶它。
 */

const { ctx } = vi.hoisted(() => ({ ctx: { role: 'viewer' as string } }))

vi.mock('~~/server/utils/workspace-auth', () => ({
  requireCapability: vi.fn(async () => ({ workspaceId: 'w1', role: ctx.role })),
}))
vi.mock('~~/server/utils/firebase', () => ({
  getDoc: vi.fn(async () => ({
    id: 'b1',
    workspaceId: 'w1',
    audienceSnapshot: { filter: null, estimatedCount: 2, resolvedUserIds: ['Ua', 'Ub'] },
  })),
}))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('getRouterParam', () => 'b1')
vi.stubGlobal('getQuery', () => ({ withAudienceIds: '1' }))
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./[id].get')

describe('GET /api/broadcast/:id?withAudienceIds=1', () => {
  it('🔴 觀察者／客服帶了 → 照樣回推播內容，⛔ 名單是空的', async () => {
    for (const role of ['viewer', 'agent']) {
      ctx.role = role
      const r = await (handler as any)({})
      expect(r.audienceSnapshot.resolvedUserIds).toEqual([])
      expect(r.audienceSnapshot.estimatedCount).toBe(2)
    }
  })

  it('管理員（含擁有者）→ 拿得到完整名單', async () => {
    for (const role of ['admin', 'owner']) {
      ctx.role = role
      const r = await (handler as any)({})
      expect(r.audienceSnapshot.resolvedUserIds).toEqual(['Ua', 'Ub'])
    }
  })
})
