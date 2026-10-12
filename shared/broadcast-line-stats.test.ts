import { describe, expect, it } from 'vitest'
import {
  lineStatsDueRound,
  lineStatsExpired,
  lineStatsNextDueAt,
  LINE_STATS_MAX_AGE_DAYS,
  LINE_STATS_RETRY_MS,
  parseStoredLineStats,
  type StoredLineStats,
} from './broadcast-line-stats'

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

describe('lineStatsExpired（發完超過 28 天＝LINE 查不到）', () => {
  it('剛好 28 天還算查得到，再多一點就不行；完成時間讀不出來不算過期', () => {
    expect(lineStatsExpired(SENT, SENT + LINE_STATS_MAX_AGE_DAYS * DAY)).toBe(false)
    expect(lineStatsExpired(SENT, SENT + LINE_STATS_MAX_AGE_DAYS * DAY + 1)).toBe(true)
    expect(lineStatsExpired(null, SENT)).toBe(false)
    expect(lineStatsExpired(Number.NaN, SENT)).toBe(false)
  })
})

describe('lineStatsNextDueAt（排程只讀「時間到了」的那幾則）', () => {
  it('還沒問過＝第 1 天；問到第 1／2 輪＝第 3／7 天；三輪問完＝不用再問', () => {
    expect(lineStatsNextDueAt(SENT, null)).toBe(SENT + DAY)
    expect(lineStatsNextDueAt(SENT, { round: 1 })).toBe(SENT + 3 * DAY)
    expect(lineStatsNextDueAt(SENT, { round: 2 })).toBe(SENT + 7 * DAY)
    expect(lineStatsNextDueAt(SENT, { round: 3 })).toBeNull()
  })

  it('問失敗：至少等 6 小時；等完已經超過 28 天就不再問', () => {
    const errorAt = SENT + 10 * DAY
    expect(lineStatsNextDueAt(SENT, { round: 2, errorAt })).toBe(errorAt + LINE_STATS_RETRY_MS)
    expect(lineStatsNextDueAt(SENT, { round: 2, errorAt: SENT + 28 * DAY - 1000 })).toBeNull()
  })

  it('沒帶統計標記、時間壞掉＝不用問', () => {
    expect(lineStatsNextDueAt(SENT, { round: 0, unavailable: true })).toBeNull()
    expect(lineStatsNextDueAt(Number.NaN, null)).toBeNull()
    expect(lineStatsNextDueAt(null, null)).toBeNull()
  })

  it('⭐ 跟 lineStatsDueRound 同一套規則：任何時間點「該問」⇔「時間到了而且還沒過期」', () => {
    const states: (Partial<StoredLineStats> | null)[] = [
      null,
      { round: 0, errorAt: SENT + 2 * DAY },
      { round: 1 },
      { round: 1, errorAt: SENT + 3 * DAY + 3600_000 },
      { round: 2 },
      { round: 2, errorAt: SENT + 27.9 * DAY },
      { round: 3 },
      { round: 1, unavailable: true },
    ]
    for (const s of states) {
      for (let h = 0; h <= 30 * 24; h += 1) {
        const now = SENT + h * 3600_000
        const next = lineStatsNextDueAt(SENT, s)
        const due = lineStatsDueRound(SENT, now, s) != null
        expect(due, `${JSON.stringify(s)} @${h}h`).toBe(next != null && next <= now && !lineStatsExpired(SENT, now))
      }
    }
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
