/**
 * 標籤旁「最近 9/3・3 次」的文案（`D-55`）。
 * 釘的是兩條不能退讓的規則：沒有值就不顯示（不可以拿「第一次貼上」頂替）、
 * 只有 1 次就不印次數（「1 次」跟「沒記錄」在畫面上會被讀成同一件事）。
 */
import { describe, expect, it } from 'vitest'
import { tagHitLabel } from './tag-hit-label'

/** 固定「現在」＝2026-09-10，讓跨年那條測試不會隨真實日期漂 */
const NOW = new Date('2026-09-10T12:00:00+08:00').getTime()
const at = (iso: string) => new Date(iso).getTime()

describe('tagHitLabel', () => {
  it('判到 3 次 → 日期＋次數', () => {
    const r = tagHitLabel({ lastHitAtMs: at('2026-09-03T10:00:00+08:00'), hitCount: 3 }, NOW)
    expect(r.text).toBe('最近 9/3・3 次')
    expect(r.title).toContain('累計 3 次')
    expect(r.title).toContain('客服手動貼的不算')
  })

  it('只判到 1 次 → 只印日期（⛔ 不印「1 次」，那跟「沒記錄」會被讀成同一件事）', () => {
    const r = tagHitLabel({ lastHitAtMs: at('2026-09-03T10:00:00+08:00'), hitCount: 1 }, NOW)
    expect(r.text).toBe('最近 9/3')
    expect(r.title).not.toContain('累計')
  })

  /**
   * 🔴 客服手動貼的標籤天生沒有 `lastHitAtMs`。
   * ⛔ 這時候**不可以**退回 `createdAt`——那是「第一次貼上」，跟「最後一次被判到」
   *   是兩件不同的事實，頂替就是在畫面上製造假資料。空著才誠實。
   */
  it('🔴 沒有「最近一次」→ 整截不顯示（手動貼的標籤）', () => {
    expect(tagHitLabel({ lastHitAtMs: null, hitCount: 0 }, NOW)).toEqual({ text: '', title: '' })
    expect(tagHitLabel({}, NOW)).toEqual({ text: '', title: '' })
    expect(tagHitLabel({ lastHitAtMs: 0, hitCount: 5 }, NOW)).toEqual({ text: '', title: '' })
  })

  it('有日期但次數壞掉／缺失 → 當成 1 次，只印日期（不要整截消失）', () => {
    expect(tagHitLabel({ lastHitAtMs: at('2026-09-03T10:00:00+08:00') }, NOW).text).toBe('最近 9/3')
    expect(tagHitLabel({ lastHitAtMs: at('2026-09-03T10:00:00+08:00'), hitCount: -2 }, NOW).text).toBe('最近 9/3')
  })

  it('去年的日期要帶年份（否則「12/3」看起來像上週）', () => {
    const r = tagHitLabel({ lastHitAtMs: at('2025-12-03T10:00:00+08:00'), hitCount: 2 }, NOW)
    expect(r.text).toBe('最近 2025/12/3・2 次')
  })

  it('壞掉的時間戳（字串／NaN）不會印出 Invalid Date', () => {
    expect(tagHitLabel({ lastHitAtMs: Number.NaN, hitCount: 3 }, NOW)).toEqual({ text: '', title: '' })
    expect(tagHitLabel({ lastHitAtMs: 'x' as unknown as number, hitCount: 3 }, NOW)).toEqual({ text: '', title: '' })
  })

  it('次數是小數（不該發生，但別印出 3.7 次）', () => {
    expect(tagHitLabel({ lastHitAtMs: at('2026-09-03T10:00:00+08:00'), hitCount: 3.7 }, NOW).text)
      .toBe('最近 9/3・3 次')
  })
})
