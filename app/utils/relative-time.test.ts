import { describe, expect, it } from 'vitest'
import { calendarDate, relativeTime } from './relative-time'

/**
 * G-27⑥：客人卡上「加入於 2026/8/23」與「最後來訊 8/23」兩種寫法，改走同一支。
 * 順便修掉一個會誤讀的地方：去年的 8/23 舊寫法也只印「8/23」，看起來像上週。
 */
describe('日曆日期的統一寫法', () => {
  const NOW = Date.parse('2026-08-24T12:00:00+08:00')

  it('今年只印月日', () => {
    expect(calendarDate(Date.parse('2026-08-23T10:00:00+08:00'), NOW)).toBe('8/23')
  })

  it('去年要補上年份——不補的話「8/23」會被讀成上週', () => {
    expect(calendarDate(Date.parse('2025-08-23T10:00:00+08:00'), NOW)).toBe('2025/8/23')
  })

  it('跨年那一天：1/1 的今年不補年、12/31 的去年要補', () => {
    const newYear = Date.parse('2026-01-01T09:00:00+08:00')
    expect(calendarDate(newYear, NOW)).toBe('1/1')
    expect(calendarDate(Date.parse('2025-12-31T23:00:00+08:00'), NOW)).toBe('2025/12/31')
  })

  it('沒有時間就回空字串（不要印出 1970/1/1）', () => {
    expect(calendarDate(0, NOW)).toBe('')
  })
})

/**
 * relativeTime 超過一天就改印日期——那一段必須走 calendarDate，
 * 否則「幾天前的訊息」和「加入於」又會變回兩種寫法（這正是 G-27⑥ 要修的）。
 */
describe('relativeTime 超過一天的那一段要跟 calendarDate 同一個寫法', () => {
  it('去年的時間 → 帶年份（沒有委派給 calendarDate 的話這裡會少掉年份）', () => {
    const lastYear = Date.now() - 400 * 86_400_000
    expect(relativeTime(lastYear)).toBe(calendarDate(lastYear))
    expect(relativeTime(lastYear)).toMatch(/^\d{4}\//)
  })

  it('一天內還是講「幾小時前」，沒有被改掉', () => {
    expect(relativeTime(Date.now() - 3 * 3_600_000)).toBe('3 小時前')
  })
})
