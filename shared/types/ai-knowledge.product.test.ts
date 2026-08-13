import { describe, expect, it } from 'vitest'
import { needsProductName } from './ai-knowledge'

/**
 * 「這份資料該設所屬產品卻沒設」的判定。
 *
 * 為什麼要有測試：這把尺同時給**知識庫體檢的清單**與**資料列表那一列**用。
 * 兩邊各寫一次判斷的話會出現「列表標著未設產品、體檢卻不算它」——
 * 本專案已經在「內容過短」上踩過同一種雷（體檢說有 5 條、點進去一條都沒標記）。
 */
describe('needsProductName', () => {
  const manual = { type: 'file', productName: '', generateOverview: false, chunkCount: 12 }

  it('多條的檔案資料沒設產品名 → 要提醒（說明書無主，客人指名問可能拿別台的內容回答）', () => {
    expect(needsProductName(manual)).toBe(true)
  })

  it('已經設了產品名 → 不提醒', () => {
    expect(needsProductName({ ...manual, productName: 'GPLUS 智慧除濕機 12L' })).toBe(false)
    // 只有空白也算沒設
    expect(needsProductName({ ...manual, productName: '   ' })).toBe(true)
  })

  it('型錄／列表資料 → 不提醒（旗下本來就是很多不同產品，問「是哪一台」沒有意義）', () => {
    expect(needsProductName({ ...manual, generateOverview: true })).toBe(false)
  })

  it('網址與試算表 → 不提醒（FAQ／公告多產品是正常的，標出來只會變成雜訊）', () => {
    expect(needsProductName({ ...manual, type: 'url' })).toBe(false)
    expect(needsProductName({ ...manual, type: 'gsheet' })).toBe(false)
    expect(needsProductName({ ...manual, type: 'manual' })).toBe(false)
  })

  it('條數太少 → 不提醒（一兩條的檔案不是說明書，逼人填只是噪音）', () => {
    expect(needsProductName({ ...manual, chunkCount: 4 })).toBe(false)
    expect(needsProductName({ ...manual, chunkCount: 5 })).toBe(true)
  })

  it('欄位缺漏不當成「該設」（舊資料沒有這些欄位時不要整批亮紅字）', () => {
    expect(needsProductName({})).toBe(false)
    expect(needsProductName({ type: 'file' })).toBe(false)
  })
})
