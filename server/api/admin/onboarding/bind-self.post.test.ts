import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 開帳「是我」（`G-107`⑪，2026-09-29 權限盤點）：`D-103`「名單只收綁好的成員」。
 * 原本組織管理員、超管（沒有成員文件、綁不了）按「是我」照樣加進通知名單——
 * 名單上多一支對不上任何成員的手機，成員頁拿不掉、改角色也管不到它。
 */

const WHO = { lineUserId: `U${'a'.repeat(32)}`, displayName: '阿豪', pictureUrl: '', via: 'follow' as const }

vi.mock('~~/server/utils/firebase', () => ({ getDb: () => ({}) }))
vi.mock('~~/server/utils/workspace-auth', () => ({ requireCapability: vi.fn(async () => ({ workspaceId: 'w1', uid: 'u1' })) }))
vi.mock('~~/server/utils/onboarding-phone-test', () => ({
  confirmPhoneFollower: vi.fn(async () => WHO),
  phoneTestSince: vi.fn(() => 0),
}))
vi.mock('~~/server/utils/member-line-bind', () => ({
  bindMemberLineUser: vi.fn(async () => true),
  addToHandoffNotify: vi.fn(async () => 'added'),
}))
vi.mock('~~/server/utils/audit-log', () => ({ writeAuditLog: vi.fn(async () => {}) }))

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('readBody', async () => ({ lineUserId: WHO.lineUserId, lookbackMs: 60_000 }))
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { default: handler } = await import('./bind-self.post')
const { bindMemberLineUser, addToHandoffNotify } = await import('~~/server/utils/member-line-bind')

beforeEach(() => {
  vi.mocked(bindMemberLineUser).mockReset().mockResolvedValue(true)
  vi.mocked(addToHandoffNotify).mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/admin/onboarding/bind-self', () => {
  it('綁到成員身上 → 加進通知名單', async () => {
    const r = await (handler as any)({})
    expect(r).toMatchObject({ memberBound: true, notify: 'added' })
    expect(addToHandoffNotify).toHaveBeenCalledWith('w1', WHO.lineUserId, '阿豪')
  })

  it('🔴 沒有成員文件（組織管理員／超管）→ ⛔ 不加進名單，回 not-member', async () => {
    vi.mocked(bindMemberLineUser).mockResolvedValue(false)
    const r = await (handler as any)({})
    expect(r).toMatchObject({ memberBound: false, notify: 'not-member' })
    expect(addToHandoffNotify).not.toHaveBeenCalled()
  })

  it('🔴 綁的時候出錯 → 500 講下一步，⛔ 不加進名單（原本吞掉錯誤後照樣加）', async () => {
    vi.mocked(bindMemberLineUser).mockRejectedValue(new Error('boom'))
    await expect((handler as any)({})).rejects.toMatchObject({ statusCode: 500 })
    expect(addToHandoffNotify).not.toHaveBeenCalled()
  })
})
