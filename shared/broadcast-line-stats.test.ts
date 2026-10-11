import { describe, expect, it } from 'vitest'
import { lineStatsDueRound, LINE_STATS_RETRY_MS, parseStoredLineStats } from './broadcast-line-stats'

const DAY = 86_400_000
const SENT = Date.UTC(2026, 9, 1, 13)

describe('lineStatsDueRound（發完第 1／3／7 天各問 LINE 一次）', () => {
  it('發完不到一天不問（LINE 還沒算好）', () => {
    expect(lineStatsDueRound(SENT, SENT + DAY / 2, null)).toBeNull()
  })

  it('第 1、3、7 天各輪到一次，問過的那一輪不再問', () => {
    expect(lineStatsDueRound(SENT, SENT + DAY, null)).toBe(1)
    expect(lineStatsDueRound(SENT, SENT + 2 * DAY, { round: 1 })).toBeNull()
    expect(lineStatsDueRound(SENT, SENT + 3 * DAY, { round: 1 })).toBe(2)
    expect(lineStatsDueRound(SENT, SENT + 7 * DAY, { round: 2 })).toBe(3)
    expect(lineStatsDueRound(SENT, SENT + 20 * DAY, { round: 3 })).toBeNull()
  })

  it('⭐ 漏掉的直接補到最新那一輪（功能上線當天，一個月內的舊推播各問一次就補齊）', () => {
    expect(lineStatsDueRound(SENT, SENT + 10 * DAY, null)).toBe(3)
  })

  it('⛔ 超過 28 天不問（LINE 用現在的查法查不到，問了只是浪費次數）', () => {
    expect(lineStatsDueRound(SENT, SENT + 29 * DAY, null)).toBeNull()
  })

  it('發送時沒帶統計標記的不問', () => {
    expect(lineStatsDueRound(SENT, SENT + 3 * DAY, { round: 3, unavailable: true })).toBeNull()
  })

  it('問失敗的 6 小時內不再問，過了再試（失敗不推進輪次）', () => {
    const now = SENT + 3 * DAY
    expect(lineStatsDueRound(SENT, now, { round: 1, errorAt: now - 60_000 })).toBeNull()
    expect(lineStatsDueRound(SENT, now, { round: 1, errorAt: now - LINE_STATS_RETRY_MS - 1 })).toBe(2)
  })

  it('時間壞掉不炸', () => {
    expect(lineStatsDueRound(Number.NaN, SENT, null)).toBeNull()
  })
})

describe('parseStoredLineStats', () => {
  it('抓到過就回人數（人太少 LINE 給 null 的照樣是 null，⛔ 不轉成 0）', () => {
    expect(parseStoredLineStats({ opened: 785, clicked: 443, round: 3, fetchedAt: 1 })).toEqual({ opened: 785, clicked: 443 })
    expect(parseStoredLineStats({ opened: 74, clicked: null, round: 1, fetchedAt: 1 })).toEqual({ opened: 74, clicked: null })
  })

  it('還沒成功抓到過（只有失敗紀錄）＝null，畫面講「還沒拿到」', () => {
    expect(parseStoredLineStats({ opened: null, clicked: null, round: 0, errorAt: 1, error: '500' })).toBeNull()
    expect(parseStoredLineStats(undefined)).toBeNull()
    expect(parseStoredLineStats('壞掉')).toBeNull()
  })

  it('沒帶統計標記的照實回 unavailable', () => {
    expect(parseStoredLineStats({ opened: null, clicked: null, round: 3, unavailable: true })).toEqual({ opened: null, clicked: null, unavailable: true })
  })
})
