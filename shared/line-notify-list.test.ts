/**
 * 通知名單比對（`C-271`⑭：原本同一行比對抄了四份）。
 */
import { describe, expect, it } from 'vitest'
import { normalizeLineUserId, notifyListHas } from './line-notify-list'

const U1 = `U${'a'.repeat(32)}`

describe('normalizeLineUserId', () => {
  it('舊資料存成 `{workspaceId}_U…` 的收斂成純 LINE userId（不然推播會被 LINE 判無效、靜默失敗）', () => {
    expect(normalizeLineUserId(`ws-1_${U1}`)).toBe(U1)
    expect(normalizeLineUserId(U1)).toBe(U1)
  })
  it('底線後面不像 LINE userId 就原樣留著（⛔ 不亂切）', () => {
    expect(normalizeLineUserId('abc_def')).toBe('abc_def')
    expect(normalizeLineUserId('  x ')).toBe('x')
  })
})

describe('notifyListHas', () => {
  it('兩種存法都認得', () => {
    expect(notifyListHas([`ws-1_${U1}`], U1)).toBe(true)
    expect(notifyListHas([U1], `ws-1_${U1}`)).toBe(true)
    expect(notifyListHas([`U${'b'.repeat(32)}`], U1)).toBe(false)
  })
  it('空字串不算在名單上', () => {
    expect(notifyListHas([''], '')).toBe(false)
  })
})
