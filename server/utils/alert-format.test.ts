import { describe, expect, it } from 'vitest'
import { cleanReason, humanizeHours } from './alert-format'

describe('cleanReason', () => {
  it('砍掉黏在後面的 JSON，只留人話（正式資料的實際形狀）', () => {
    const raw = '自動檢查失敗：Google Sheets API 錯誤 503：{\n  "error": {\n    "code": 503,\n    "message": "The service is currently unavailable."\n  }\n}'
    expect(cleanReason(raw)).toBe('自動檢查失敗：Google Sheets API 錯誤 503')
  })

  it('把換行與連續空白收成單一空格，不讓小卡爆版', () => {
    expect(cleanReason('試算表沒有\n\n分享給   服務帳號')).toBe('試算表沒有 分享給 服務帳號')
  })

  it('過長時截斷並補刪節號，不會截在標點後留下懸空的冒號', () => {
    const out = cleanReason('原因'.repeat(60), 20)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(21)
  })

  it('整串就是 JSON 時保留內容，不要砍成空字串（什麼都沒說比截斷更糟）', () => {
    expect(cleanReason('{"code":503}')).toBe('{"code":503}')
  })

  it('空值回空字串，讓呼叫端可以決定不顯示這一行', () => {
    expect(cleanReason(null)).toBe('')
    expect(cleanReason(undefined)).toBe('')
    expect(cleanReason('   ')).toBe('')
  })
})

describe('humanizeHours', () => {
  it('不到 1 小時講分鐘', () => {
    expect(humanizeHours(0.5)).toBe('30 分鐘')
  })

  it('不會出現「0 分鐘」這種讀起來像沒事的說法', () => {
    expect(humanizeHours(0.001)).toBe('1 分鐘')
  })

  it('超過 1 小時講小時', () => {
    expect(humanizeHours(53.4)).toBe('53 小時')
  })

  it('無效值不炸開，回一個保守的說法', () => {
    expect(humanizeHours(Number.NaN)).toBe('不到 1 分鐘')
    expect(humanizeHours(-5)).toBe('不到 1 分鐘')
  })
})
