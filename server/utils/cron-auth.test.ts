import { describe, expect, it, vi } from 'vitest'

/**
 * 排程密鑰比對（`G-107`⑬，2026-09-29 權限盤點）：原本三處用 `!==`，不是常數時間。
 */

let cronSecret = 's3cret-value'
let headers: Record<string, string> = {}
vi.stubGlobal('useRuntimeConfig', () => ({ cronSecret }))
vi.stubGlobal('getHeader', (_e: unknown, name: string) => headers[name.toLowerCase()])
vi.stubGlobal('createError', (o: { statusCode?: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'error'), o))

const { safeSecretEqual, assertCronAuthorized } = await import('./cron-auth')

describe('safeSecretEqual', () => {
  it('相同才 true；長度不同、內容不同都 false', () => {
    expect(safeSecretEqual('abc', 'abc')).toBe(true)
    expect(safeSecretEqual('abd', 'abc')).toBe(false)
    expect(safeSecretEqual('abcd', 'abc')).toBe(false)
    expect(safeSecretEqual('密鑰', '密鑰')).toBe(true)
  })

  it('🔴 任一邊空字串一律 false（沒設密鑰 ⛔ 不能變成「不帶密鑰就通過」）', () => {
    expect(safeSecretEqual('', '')).toBe(false)
    expect(safeSecretEqual('', 'abc')).toBe(false)
    expect(safeSecretEqual('abc', '')).toBe(false)
  })
})

describe('assertCronAuthorized', () => {
  it('密鑰對 → 放行；不對 → 401', () => {
    cronSecret = 's3cret-value'
    headers = { 'x-cron-secret': 's3cret-value' }
    expect(() => assertCronAuthorized({} as never)).not.toThrow()
    headers = { 'x-cron-secret': 's3cret-valuX' }
    expect(() => assertCronAuthorized({} as never)).toThrow(expect.objectContaining({ statusCode: 401 }))
    headers = {}
    expect(() => assertCronAuthorized({} as never)).toThrow(expect.objectContaining({ statusCode: 401 }))
  })
})
