/**
 * 通知名單比對（`C-271`⑭：原本同一行比對抄了四份）。
 */
import { describe, expect, it } from 'vitest'
import { normalizeLineUserId, normalizeNotifyOptOut, notifyKindsFor, notifyListHas, notifyRecipients } from './line-notify-list'

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

const U2 = `U${'b'.repeat(32)}`

describe('每個人收哪幾種（`D-143`）', () => {
  it('沒記＝三種都收（舊資料不用回填，上線那天沒有人少收）', () => {
    expect(normalizeNotifyOptOut(undefined, [U1])).toEqual({})
    expect(notifyKindsFor({}, U1)).toEqual(['handoff', 'digest', 'crit'])
  })
  it('只留名單上的人、只留認得的種類；舊格式的 key 收成純 userId', () => {
    const out = normalizeNotifyOptOut({ [`ws_${U1}`]: ['digest', 'bogus'], [U2]: ['crit'], Ugone: ['crit'] }, [U1])
    expect(out).toEqual({ [U1]: ['digest'] })
  })
  it('🔴 舊的全帳號「出大事」開關關著＝每個人都不收出大事（⛔ 上線後不可以突然開始傳）', () => {
    const out = normalizeNotifyOptOut({ [U1]: ['digest'] }, [U1, U2], { critOffForAll: true })
    expect(out).toEqual({ [U1]: ['digest', 'crit'], [U2]: ['crit'] })
  })
  it('某一種只傳給名單上、沒取消這一種的人（回傳名單上原本的字串）', () => {
    const cfg = { lineUserIds: [`ws_${U1}`, U2], optOut: { [U1]: ['handoff' as const] } }
    expect(notifyRecipients(cfg, 'handoff')).toEqual([U2])
    expect(notifyRecipients(cfg, 'digest')).toEqual([`ws_${U1}`, U2])
    expect(notifyRecipients({ lineUserIds: [] }, 'crit')).toEqual([])
  })
})
