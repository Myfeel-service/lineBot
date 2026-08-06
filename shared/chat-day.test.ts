import { describe, expect, it } from 'vitest'
import { chatDayKey, formatChatDayLabel } from './chat-day'

// 基準：2026-08-07(五) 14:30 本地時間。所有相對日期都以這個當「現在」，不吃系統時鐘。
const NOW = new Date(2026, 7, 7, 14, 30).getTime()
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime()

describe('chatDayKey(跨日判斷)', () => {
  it('同一天不同時間 = 同一個 key', () => {
    expect(chatDayKey(at(2026, 8, 5, 0, 1))).toBe(chatDayKey(at(2026, 8, 5, 23, 59)))
  })

  it('隔天就是不同 key(差幾分鐘也算跨日)', () => {
    expect(chatDayKey(at(2026, 8, 5, 23, 59))).not.toBe(chatDayKey(at(2026, 8, 6, 0, 1)))
  })

  it('月/日補零,字串長度固定', () => {
    expect(chatDayKey(at(2026, 1, 3))).toBe('2026-01-03')
  })
})

describe('formatChatDayLabel(分隔線上的字)', () => {
  it('今天/昨天講白話,不印日期', () => {
    expect(formatChatDayLabel(at(2026, 8, 7, 9, 0), NOW)).toBe('今天')
    expect(formatChatDayLabel(at(2026, 8, 6, 23, 30), NOW)).toBe('昨天')
  })

  it('同一年:8月5日(三) —— 帶星期、不帶年', () => {
    expect(formatChatDayLabel(at(2026, 8, 5), NOW)).toBe('8月5日(三)')
    expect(formatChatDayLabel(at(2026, 2, 1), NOW)).toBe('2月1日(日)')
  })

  it('跨年才補年份', () => {
    expect(formatChatDayLabel(at(2025, 8, 5), NOW)).toBe('2025年8月5日(二)')
  })

  it('跨月的「昨天」也算昨天(月初不會退化成日期)', () => {
    const firstOfMonth = new Date(2026, 7, 1, 10, 0).getTime()
    expect(formatChatDayLabel(at(2026, 7, 31), firstOfMonth)).toBe('昨天')
  })

  it('跨年的「昨天」也算昨天', () => {
    const newYear = new Date(2026, 0, 1, 10, 0).getTime()
    expect(formatChatDayLabel(at(2025, 12, 31), newYear)).toBe('昨天')
  })
})
