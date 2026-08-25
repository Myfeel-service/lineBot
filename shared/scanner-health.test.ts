import { describe, expect, it } from 'vitest'
import {
  HEALTHY_SCANNER,
  isScannerStalled,
  nextScannerHealth,
  readScannerHealth,
  SCANNER_STALE_MS,
} from './scanner-health'

const NOW = Date.parse('2026-08-25T12:00:00+08:00')

describe('掃描器健康狀態：讀取', () => {
  it('沒有 health 欄位＝健康（舊資料不誤報）', () => {
    expect(readScannerHealth(undefined)).toEqual(HEALTHY_SCANNER)
    expect(readScannerHealth({})).toEqual(HEALTHY_SCANNER)
  })

  it('讀得出失敗時間、訊息與「從什麼時候開始連續失敗」', () => {
    expect(readScannerHealth({ health: { lastErrorMs: 5, lastError: 'boom', failingSinceMs: 3 } }))
      .toEqual({ lastErrorMs: 5, lastError: 'boom', failingSinceMs: 3 })
  })
})

describe('掃描器健康狀態：算不算壞了', () => {
  it('沒失敗過 → 不算', () => {
    expect(isScannerStalled(HEALTHY_SCANNER, NOW)).toBe(false)
  })

  it('剛失敗一次 → 還不算（偶發逾時不值得吵人）', () => {
    expect(isScannerStalled({ lastErrorMs: NOW, lastError: 'x', failingSinceMs: NOW }, NOW)).toBe(false)
  })

  it('連續失敗超過門檻 → 算壞了', () => {
    const since = NOW - SCANNER_STALE_MS - 1
    expect(isScannerStalled({ lastErrorMs: NOW, lastError: 'x', failingSinceMs: since }, NOW)).toBe(true)
  })

  /**
   * ⛔ 這條是 C-68 的核心：那支掃描器「壞了兩天、而且每 10 分鐘又失敗一次」。
   * 若用 lastErrorMs（最後一次失敗）判斷，它永遠很新 → 永遠判成健康，異常永遠不會響。
   */
  it('壞很久但剛剛又失敗一次 → 仍然算壞了（不可以用 lastErrorMs 判斷）', () => {
    const health = { lastErrorMs: NOW, lastError: 'index missing', failingSinceMs: NOW - 2 * 86_400_000 }
    expect(isScannerStalled(health, NOW)).toBe(true)
  })
})

describe('掃描器健康狀態：這輪跑完要寫什麼', () => {
  it('一路正常 → 回 null＝不用寫（不製造每 10 分鐘一次的寫入風暴）', () => {
    expect(nextScannerHealth(HEALTHY_SCANNER, { ok: true }, NOW)).toBeNull()
  })

  it('從失敗恢復 → 清成健康', () => {
    const broken = { lastErrorMs: NOW - 1000, lastError: 'boom', failingSinceMs: NOW - 9999 }
    expect(nextScannerHealth(broken, { ok: true }, NOW)).toEqual(HEALTHY_SCANNER)
  })

  it('第一次失敗 → 記下 failingSince＝現在', () => {
    const next = nextScannerHealth(HEALTHY_SCANNER, { ok: false, error: new Error('boom') }, NOW)
    expect(next).toEqual({ lastErrorMs: NOW, lastError: 'boom', failingSinceMs: NOW })
  })

  it('⛔ 連續失敗 → failingSince 保持第一次的時間，不可以被刷新', () => {
    const first = NOW - 3 * 86_400_000
    const next = nextScannerHealth(
      { lastErrorMs: NOW - 600_000, lastError: 'boom', failingSinceMs: first },
      { ok: false, error: new Error('still broken') },
      NOW,
    )
    expect(next?.failingSinceMs).toBe(first)
    expect(next?.lastErrorMs).toBe(NOW)
  })

  it('錯誤訊息截短（不要把整串 stack 寫進 Firestore）', () => {
    const next = nextScannerHealth(HEALTHY_SCANNER, { ok: false, error: new Error('x'.repeat(500)) }, NOW)
    expect(next!.lastError.length).toBe(300)
  })
})
