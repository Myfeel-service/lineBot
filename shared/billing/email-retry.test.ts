import { describe, expect, it } from 'vitest'
import { EMAIL_MAX_ATTEMPTS, EMAIL_RETRY_COOLDOWN_MS, emailAttemptAllowed, emailAttemptsExhausted, nextEmailAttempt } from './email-retry'

/** `B-49`：帳務信寄失敗要重試、但排程每 10 分鐘一輪，不能無限重寄 */
describe('emailAttemptAllowed', () => {
  const NOW = 10 * EMAIL_RETRY_COOLDOWN_MS

  it('沒試過、或上次試的是別封（別期）→ 可以寄', () => {
    expect(emailAttemptAllowed(null, '2026-10-20', NOW)).toBe(true)
    expect(emailAttemptAllowed({ key: '2026-09-20', attempts: EMAIL_MAX_ATTEMPTS, lastAttemptAt: NOW }, '2026-10-20', NOW)).toBe(true)
  })

  it('🔴 剛寄失敗、還在冷卻 → 這輪不試（否則設定壞掉時一天試 144 次）', () => {
    expect(emailAttemptAllowed({ key: 'k', attempts: 1, lastAttemptAt: NOW - 10 * 60_000 }, 'k', NOW)).toBe(false)
    expect(emailAttemptAllowed({ key: 'k', attempts: 1, lastAttemptAt: NOW - EMAIL_RETRY_COOLDOWN_MS + 1 }, 'k', NOW)).toBe(false)
  })

  it('冷卻過了 → 再試', () => {
    expect(emailAttemptAllowed({ key: 'k', attempts: 1, lastAttemptAt: NOW - EMAIL_RETRY_COOLDOWN_MS }, 'k', NOW)).toBe(true)
  })

  it('🔴 試滿上限 → 不再試（冷卻再久也一樣）', () => {
    expect(emailAttemptAllowed({ key: 'k', attempts: EMAIL_MAX_ATTEMPTS, lastAttemptAt: 0 }, 'k', NOW)).toBe(false)
  })
})

describe('nextEmailAttempt', () => {
  it('同一封累加次數、換一封從 1 開始；用完次數會被認出來', () => {
    const a1 = nextEmailAttempt(null, 'k', 100)
    expect(a1).toEqual({ key: 'k', attempts: 1, lastAttemptAt: 100 })
    const a2 = nextEmailAttempt(a1, 'k', 200)
    expect(a2).toEqual({ key: 'k', attempts: 2, lastAttemptAt: 200 })
    expect(nextEmailAttempt(a2, 'other', 300)).toEqual({ key: 'other', attempts: 1, lastAttemptAt: 300 })
    expect(emailAttemptsExhausted({ key: 'k', attempts: EMAIL_MAX_ATTEMPTS, lastAttemptAt: 0 })).toBe(true)
    expect(emailAttemptsExhausted(a2)).toBe(false)
  })
})
