import { describe, expect, it } from 'vitest'
import { calendarDate, elapsedSince, relativeTime } from './relative-time'

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

/**
 * G-27 code review 抓到：AI 標籤建議約每週產生一次，所以打開頁面時它幾乎永遠超過
 * 24 小時 → relativeTime 會印「8/4」，本來想講的「放三週沒人動」變成要讀者自己算。
 */
describe('陳放時間：要回答「擱著多久了」不是「哪一天的事」', () => {
  const NOW = Date.parse('2026-08-25T12:00:00+08:00')
  const days = (n: number) => NOW - n * 86_400_000

  it('⛔ 超過一天要講「N 天前」，不可以掉回日期（那正是 relativeTime 做的事）', () => {
    expect(elapsedSince(days(3), NOW)).toBe('3 天前')
    expect(elapsedSince(days(3), NOW)).not.toBe(calendarDate(days(3), NOW))
  })

  it('一天內沿用時分的講法', () => {
    expect(elapsedSince(NOW - 30_000, NOW)).toBe('剛剛')
    expect(elapsedSince(NOW - 5 * 60_000, NOW)).toBe('5 分鐘前')
    expect(elapsedSince(NOW - 5 * 3_600_000, NOW)).toBe('5 小時前')
  })

  it('兩週以上改用週、兩個月以上改用月（不要出現「87 天前」這種要自己換算的數字）', () => {
    expect(elapsedSince(days(13), NOW)).toBe('13 天前')
    expect(elapsedSince(days(21), NOW)).toBe('3 週前')
    expect(elapsedSince(days(90), NOW)).toBe('3 個月前')
  })

  it('沒有時間回空字串；未來時間當「剛剛」（時鐘偏移不要印出負數）', () => {
    expect(elapsedSince(0, NOW)).toBe('')
    expect(elapsedSince(NOW + 60_000, NOW)).toBe('剛剛')
  })
})
