import { describe, expect, it } from 'vitest'
import { ONBOARDING_EVENTS, eventFlow, isOnboardingEvent, lineFlowEntry, sanitizeEventProps } from './onboarding-events'

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

  /**
   * `D-180`（2026-11-11）：付款那一段五格。釘住名字是因為**打錯字不會報錯**——
   * 伺服器照表收，不認得的直接丟（只在 log 留一行），而這五筆漏掉任何一格，
   * 漏斗就只剩「有幾個人付了」這個帳務本來就答得出來的數字。
   */
  it('付款那一段五格都在表裡', () => {
    for (const name of ['billing_wall_seen', 'billing_plans_open', 'billing_plan_click', 'billing_checkout', 'billing_gateway_back'])
      expect(isOnboardingEvent(name)).toBe(true)
  })

  it('⛔ 沒有「付款成功」這種事件——那一件以帳務為準，記在這裡就是第二本帳', () => {
    const names = Object.keys(ONBOARDING_EVENTS)
    expect(names.filter(n => /paid|success|purchase/.test(n))).toEqual([])
  })

  it('哪一趟只認三種，其他（含 body 上亂填的）一律 other', () => {
    expect(eventFlow('build')).toBe('build')
    expect(eventFlow('line')).toBe('line')
    expect(eventFlow('billing')).toBe('billing')
    expect(eventFlow('other')).toBe('other')
    expect(eventFlow('')).toBe('other')
    expect(eventFlow('<script>')).toBe('other')
    expect(eventFlow(undefined)).toBe('other')
    expect(eventFlow({ toString: () => 'billing' })).toBe('other') // 物件不算
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
