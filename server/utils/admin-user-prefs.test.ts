import { describe, expect, it } from 'vitest'
import { MAX_SEEN_TOURS, isValidSeenTourKey, readSeenTours, withSeenTour } from './admin-user-prefs'

describe('isValidSeenTourKey', () => {
  it('收單支與多支教學串起來的鑰匙', () => {
    expect(isValidSeenTourKey('broadcasts')).toBe(true)
    expect(isValidSeenTourKey('conversation-stats')).toBe(true)
    expect(isValidSeenTourKey('flow|msg-basic|msg-rich')).toBe(true)
  })

  it('擋掉會把 Firestore 的 map 寫成巢狀結構的鑰匙', () => {
    // ⛔ 點是欄位路徑的分隔符：放行的話 `a.b` 會變成兩層，而不是一個鍵
    expect(isValidSeenTourKey('a.b')).toBe(false)
    expect(isValidSeenTourKey('a/b')).toBe(false)
    expect(isValidSeenTourKey('__proto__')).toBe(false)
  })

  it('擋掉空的與過長的', () => {
    expect(isValidSeenTourKey('')).toBe(false)
    expect(isValidSeenTourKey('a'.repeat(201))).toBe(false)
  })
})

describe('readSeenTours', () => {
  it('沒有資料就回空的，不炸開', () => {
    expect(readSeenTours(null)).toEqual({})
    expect(readSeenTours({})).toEqual({})
    expect(readSeenTours({ seenTours: 'bad' })).toEqual({})
    expect(readSeenTours({ seenTours: ['bad'] })).toEqual({})
  })

  it('型別不對或鑰匙不合法的那幾筆丟掉，其他照留', () => {
    expect(readSeenTours({
      seenTours: { broadcasts: 1, tags: 'nope', 'a.b': 3, users: 4 },
    })).toEqual({ broadcasts: 1, users: 4 })
  })
})

describe('withSeenTour', () => {
  it('加一筆、保留舊的', () => {
    expect(withSeenTour({ tags: 1 }, 'users', 9)).toEqual({ tags: 1, users: 9 })
  })

  it('同一頁再記一次就更新時間，不會多一筆', () => {
    expect(withSeenTour({ tags: 1 }, 'tags', 9)).toEqual({ tags: 9 })
  })

  it('滿了就丟掉最早看過的那幾筆，且丟的是最早的不是隨便一筆', () => {
    const prev: Record<string, number> = {}
    for (let i = 0; i < MAX_SEEN_TOURS; i++)
      prev[`p${i}`] = i // p0 最早
    const next = withSeenTour(prev, 'newest', 99999)
    expect(Object.keys(next)).toHaveLength(MAX_SEEN_TOURS)
    expect(next.newest).toBe(99999)
    expect(next.p0).toBeUndefined()
    expect(next.p1).toBe(1)
  })
})
