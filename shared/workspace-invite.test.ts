import { describe, expect, it } from 'vitest'
import { WORKSPACE_INVITE_TTL_MS, inviteExpiresAtMs, isInviteExpired } from './workspace-invite'

/** 邀請 30 天過期（`G-107`⑥，2026-09-29 拍板） */

const NOW = Date.UTC(2026, 8, 29, 4, 0, 0)
const DAY = 24 * 60 * 60 * 1000
const ts = (ms: number) => ({ toDate: () => new Date(ms) })

describe('isInviteExpired', () => {
  it('新邀請看 expiresAt', () => {
    expect(isInviteExpired({ expiresAt: NOW + 1 }, NOW)).toBe(false)
    expect(isInviteExpired({ expiresAt: NOW }, NOW)).toBe(true)
    expect(isInviteExpired({ expiresAt: NOW - 1 }, NOW)).toBe(true)
  })

  it('⭐ 舊邀請沒有 expiresAt → createdAt + 30 天（Timestamp 與 API JSON 兩種形狀都認）', () => {
    expect(isInviteExpired({ createdAt: ts(NOW - 29 * DAY) }, NOW)).toBe(false)
    expect(isInviteExpired({ createdAt: ts(NOW - 31 * DAY) }, NOW)).toBe(true)
    expect(isInviteExpired({ createdAt: { _seconds: Math.floor((NOW - 31 * DAY) / 1000) } }, NOW)).toBe(true)
    expect(inviteExpiresAtMs({ createdAt: ts(NOW) })).toBe(NOW + WORKSPACE_INVITE_TTL_MS)
  })

  it('expiresAt 優先於 createdAt（重發時只改 expiresAt 也有效）', () => {
    expect(isInviteExpired({ expiresAt: NOW + DAY, createdAt: ts(NOW - 90 * DAY) }, NOW)).toBe(false)
  })

  it('🔴 讀不出任何時間 → 當過期（⛔ 來路不明的邀請不放行）', () => {
    expect(isInviteExpired({}, NOW)).toBe(true)
    expect(isInviteExpired(null, NOW)).toBe(true)
    expect(isInviteExpired({ expiresAt: 'abc', createdAt: 'not-a-date' }, NOW)).toBe(true)
  })
})
