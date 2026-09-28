import { timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'

/**
 * 密鑰比對一律走這支（`G-107`⑬）：常數時間，⛔ 不用 `!==`。
 * `!==` 在第一個不同的字就停，理論上可以量回應時間一個字一個字猜出 CRON_SECRET。
 * 長度不同直接回 false（`timingSafeEqual` 本身要求等長；洩漏的只有長度）。
 * 任一邊是空字串也回 false：沒設密鑰不能變成「不帶密鑰就通過」。
 */
export function safeSecretEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * 外部 Cron 端點共用的身分驗證（/api/warmup、/api/cron/run-tasks、
 * /api/broadcast/trigger-scheduled）。
 *
 * 規則：請求 Header 的 X-Cron-Secret 必須與環境變數 CRON_SECRET 相符；
 * 未設定 CRON_SECRET 時只允許同主機（localhost）呼叫。驗證失敗直接 throw。
 */
export function assertCronAuthorized(event: H3Event): void {
  const runtimeConfig = useRuntimeConfig()
  const cronSecret = String(runtimeConfig.cronSecret || '').trim()
  const headerSecret = String(getHeader(event, 'x-cron-secret') || '').trim()

  if (cronSecret) {
    if (!safeSecretEqual(headerSecret, cronSecret)) {
      throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
    }
    return
  }

  const forwarded = getHeader(event, 'x-forwarded-for') || ''
  const host = getHeader(event, 'host') || ''
  const isLocal = forwarded === '' && (host.startsWith('localhost') || host.startsWith('127.'))
  if (!isLocal) {
    throw createError({ statusCode: 403, statusMessage: 'CRON_SECRET not configured; only localhost allowed' })
  }
}
