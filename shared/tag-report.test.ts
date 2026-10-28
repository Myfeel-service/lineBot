import { describe, expect, it } from 'vitest'
import {
  canRegenerate,
  cooldownRemainingMs,
  cooldownText,
  isCurrentReportPayload,
  TAG_REPORT_COOLDOWN_MS,
} from './tag-report'

/*
 * `D-155`（2026-10-28）把 AI「一句話總結」整個拿掉了，原本那批總結的測試（薄資料、事實表、
 * `rejectTagSummary` 的數字白名單與「事件不准說成興趣」）跟著退場。
 * 「接下來該做什麼」改成程式照規則挑，測試在 `friend-report-advice.test.ts`。
 */

describe('冷卻（鐵律①：產生－存檔－沿用，不是每次開頁重算）', () => {
  const now = 1_700_000_000_000

  it('從來沒產生過 → 可以產生', () => {
    expect(canRegenerate(null, now)).toBe(true)
    expect(canRegenerate(0, now)).toBe(true)
    expect(cooldownRemainingMs(null, now)).toBe(0)
  })

  it('⛔ 一小時內不可以再算一次（一份約一萬次讀取）', () => {
    expect(canRegenerate(now - 59 * 60_000, now)).toBe(false)
    expect(cooldownRemainingMs(now - 59 * 60_000, now)).toBe(60_000)
  })

  it('滿一小時就可以', () => {
    expect(canRegenerate(now - TAG_REPORT_COOLDOWN_MS, now)).toBe(true)
  })

  it('⛔ 時間戳在未來（機器時鐘歪掉）不可以把人鎖死', () => {
    expect(canRegenerate(now + 86_400_000, now)).toBe(true)
  })

  it('冷卻訊息要說得出還要多久，不是只講「請稍後再試」', () => {
    expect(cooldownText(cooldownRemainingMs(now - 59 * 60_000, now))).toContain('1 分鐘後')
    expect(cooldownText(0)).toBe('')
  })
})

describe('舊版報告認得出來（`D-155` 以前存的那種形狀）', () => {
  it('這一版的才算', () => {
    expect(isCurrentReportPayload({ version: 2 })).toBe(true)
  })

  it('⛔ 舊版（六張卡＋AI 總結，沒有版本號）不算——畫面要請他重新產生，不可以畫成空的報告', () => {
    expect(isCurrentReportPayload({ customerExpressed: [], coverage: {} })).toBe(false)
    expect(isCurrentReportPayload(null)).toBe(false)
    expect(isCurrentReportPayload(undefined)).toBe(false)
  })
})
