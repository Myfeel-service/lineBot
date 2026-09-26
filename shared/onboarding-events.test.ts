import { describe, expect, it } from 'vitest'
import { ONBOARDING_EVENTS, isOnboardingEvent, lineFlowEntry, sanitizeEventProps } from './onboarding-events'

/**
 * 開通步驟紀錄的規矩（`C-250`③）：事件名稱照表收、附帶資料只收小東西、入口不認得的一律算 direct。
 */
describe('開通步驟紀錄：事件表', () => {
  it('表裡的名字才認得（打錯字、原型鏈上的名字都不算）', () => {
    expect(isOnboardingEvent('build_start')).toBe(true)
    expect(isOnboardingEvent('wizard_leave')).toBe(true)
    expect(isOnboardingEvent('build_stat')).toBe(false)
    expect(isOnboardingEvent('toString')).toBe(false)
    expect(isOnboardingEvent('__proto__')).toBe(false)
    expect(isOnboardingEvent(42)).toBe(false)
  })

  it('每一個事件都有一句中文說明（看紀錄的人不讀 code）', () => {
    for (const [name, desc] of Object.entries(ONBOARDING_EVENTS)) {
      expect(name).toMatch(/^[a-z][a-z_]+$/)
      expect(desc.length).toBeGreaterThan(3)
    }
  })

  it('入口只認四種，其他（含網址上亂填的）一律 direct', () => {
    expect(lineFlowEntry('band')).toBe('band')
    expect(lineFlowEntry('hero')).toBe('hero')
    expect(lineFlowEntry('pullback')).toBe('pullback')
    expect(lineFlowEntry('')).toBe('direct')
    expect(lineFlowEntry('<script>')).toBe('direct')
    expect(lineFlowEntry(undefined)).toBe('direct')
  })
})

describe('開通步驟紀錄：附帶資料只收小東西', () => {
  it('字串截到 60 字、數字取到小數三位、真假照收', () => {
    const { props, dropped } = sanitizeEventProps({ field: 'products', waitedSec: 12.34567, ok: true, note: 'x'.repeat(200) })
    expect(props).toEqual({ field: 'products', waitedSec: 12.346, ok: true, note: 'x'.repeat(60) })
    expect(dropped).toBe(0)
  })

  it('物件、陣列、NaN、null 一律丟，而且算得出丟了幾個', () => {
    const { props, dropped } = sanitizeEventProps({ a: { nested: 1 }, b: [1, 2], c: Number.NaN, d: null, e: Infinity, keep: 1 })
    expect(props).toEqual({ keep: 1 })
    expect(dropped).toBe(5)
  })

  it('鍵名不合規（大寫開頭、有空白、太長）的丟掉', () => {
    const { props, dropped } = sanitizeEventProps({ Bad: 1, 'has space': 1, [`k${'x'.repeat(40)}`]: 1, good_one: 1 })
    expect(props).toEqual({ good_one: 1 })
    expect(dropped).toBe(3)
  })

  it('最多 8 個，第 9 個起丟掉並計數', () => {
    const raw = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]))
    const { props, dropped } = sanitizeEventProps(raw)
    expect(Object.keys(props)).toHaveLength(8)
    expect(dropped).toBe(3)
  })

  it('不是物件就什麼都不收', () => {
    expect(sanitizeEventProps('hello')).toEqual({ props: {}, dropped: 0 })
    expect(sanitizeEventProps([1, 2])).toEqual({ props: {}, dropped: 0 })
    expect(sanitizeEventProps(null)).toEqual({ props: {}, dropped: 0 })
  })
})
