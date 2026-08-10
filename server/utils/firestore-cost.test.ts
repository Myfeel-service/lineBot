import { describe, it, expect } from 'vitest'
import { computeFirebaseCost, FIRESTORE_FREE_TIER, GIB, type DayUsage } from './firestore-cost'

const day = (d: string, over: Partial<DayUsage> = {}): DayUsage => ({
  day: d, reads: 0, writes: 0, deletes: 0, storageBytes: 0, fileBytes: 0, ...over,
})

describe('computeFirebaseCost', () => {
  it('免費額度內量測費用是 0（但流量費仍要算：讀第一筆就在傳資料出去）', () => {
    const r = computeFirebaseCost([
      day('2026-08-01', {
        reads: FIRESTORE_FREE_TIER.readsPerDay,
        writes: FIRESTORE_FREE_TIER.writesPerDay,
        deletes: FIRESTORE_FREE_TIER.deletesPerDay,
        storageBytes: FIRESTORE_FREE_TIER.storageGib * GIB,
      }),
    ], { multiRegion: true, daysInMonth: 31 })

    expect(r.totals.measuredCostUsd).toBe(0)
    expect(r.totals.billableReads).toBe(0)
    expect(r.totals.egressCostUsd).toBeGreaterThan(0)
    expect(r.totals.totalCostUsd).toBe(r.totals.egressCostUsd)
  })

  it('流量費＝讀取次數 × 每筆大小 × 單價，且不受免費額度影響', () => {
    const oneGib = { reads: GIB / 1024, storageBytes: 0 } // 每筆 1 KB → 剛好 1 GiB
    const r = computeFirebaseCost([day('2026-08-01', oneGib)], { multiRegion: true, daysInMonth: 31 })
    expect(r.totals.egressCostUsd).toBeCloseTo(0.12, 6)

    // 假設值可調高以估得更保守：每筆 2 KB → 流量費翻倍
    const conservative = computeFirebaseCost([day('2026-08-01', oneGib)], { multiRegion: true, daysInMonth: 31, bytesPerRead: 2048 })
    expect(conservative.totals.egressCostUsd).toBeCloseTo(0.24, 6)
    // 量測的部分不會因為假設變動而改變
    expect(conservative.totals.measuredCostUsd).toBe(r.totals.measuredCostUsd)
  })

  it('免費額度逐日扣、不是整月加總後才扣', () => {
    // 兩天各 60,000 讀 → 每天只有 10,000 要錢，共 20,000（不是 120,000-50,000=70,000）
    const r = computeFirebaseCost(
      [day('2026-08-01', { reads: 60_000 }), day('2026-08-02', { reads: 60_000 })],
      { multiRegion: true, daysInMonth: 31 },
    )
    expect(r.totals.billableReads).toBe(20_000)
    expect(r.totals.readCostUsd).toBeCloseTo((20_000 / 100_000) * 0.06, 6)
  })

  it('measuredCostUsd 只含量測、totalCostUsd 才含估算流量（前端要能分開講）', () => {
    const r = computeFirebaseCost([day('2026-08-01', { reads: 150_000 })], { multiRegion: true, daysInMonth: 31 })
    expect(r.totals.measuredCostUsd).toBeCloseTo(r.totals.readCostUsd, 6)
    expect(r.totals.totalCostUsd).toBeCloseTo(r.totals.measuredCostUsd + r.totals.egressCostUsd, 6)
    expect(r.totals.totalCostUsd).toBeGreaterThan(r.totals.measuredCostUsd)
  })

  it('儲存費按當月天數攤提：整月 2 GiB 多區域＝(2-1)×0.18', () => {
    const days = Array.from({ length: 31 }, (_, i) =>
      day(`2026-08-${String(i + 1).padStart(2, '0')}`, { storageBytes: 2 * GIB }))
    const r = computeFirebaseCost(days, { multiRegion: true, daysInMonth: 31 })
    expect(r.totals.storageCostUsd).toBeCloseTo(0.18, 5)
    // 只跑了一半的月份就只算一半，不虛報整月
    const half = computeFirebaseCost(days.slice(0, 15), { multiRegion: true, daysInMonth: 31 })
    expect(half.totals.storageCostUsd).toBeCloseTo(0.18 * 15 / 31, 5)
  })

  it('單一區域費率約為多區域的一半（流量費與位置無關，故只比量測部分）', () => {
    const days = [day('2026-08-01', { reads: 150_000, writes: 120_000 })]
    const multi = computeFirebaseCost(days, { multiRegion: true, daysInMonth: 31 })
    const regional = computeFirebaseCost(days, { multiRegion: false, daysInMonth: 31 })
    expect(regional.totals.measuredCostUsd).toBeCloseTo(multi.totals.measuredCostUsd / 2, 6)
    expect(regional.totals.egressCostUsd).toBeCloseTo(multi.totals.egressCostUsd, 6)
  })

  it('存量取最後一天、不是加總', () => {
    const r = computeFirebaseCost([
      day('2026-08-01', { storageBytes: 1 * GIB, fileBytes: 10 * 1024 ** 2 }),
      day('2026-08-02', { storageBytes: 3 * GIB, fileBytes: 20 * 1024 ** 2 }),
    ], { multiRegion: true, daysInMonth: 31 })
    expect(r.totals.storageGib).toBeCloseTo(3, 5)
    expect(r.totals.fileStorageGib).toBeCloseTo(20 / 1024, 5)
  })

  it('對得上真實帳單：myfeel 2026-08-01~09 實測用量 ≈ US$0.82', () => {
    // 取自 Cloud Monitoring 實測（linebot-e8dda，nam5 多區域）。
    // 這組數字是「開發稽核週」的真實形狀：8/4 尖峰 46 萬讀，平常日多在免費額附近。
    const reads = [79_069, 59_341, 251_806, 465_440, 260_703, 219_375, 310_696, 114_604, 61_552]
    const writes = [3640, 1776, 2130, 2968, 3343, 1811, 2801, 17_967, 3241]
    const deletes = [240, 140, 128, 236, 239, 256, 167, 193, 131]
    const days = reads.map((_, i) => day(`2026-08-${String(i + 1).padStart(2, '0')}`, {
      reads: reads[i]!, writes: writes[i]!, deletes: deletes[i]!,
      storageBytes: 341.5 * 1024 ** 2, // 340MB，仍在 1 GiB 免費額內
      fileBytes: 71.8 * 1024 ** 2, // 72MB，仍在 5 GiB 免費額內
    }))

    const r = computeFirebaseCost(days, { multiRegion: true, daysInMonth: 31 })

    expect(r.totals.reads).toBe(1_822_586)
    // 九天每天都超過 5 萬 → 免費額用好用滿 45 萬次
    expect(r.totals.billableReads).toBe(1_822_586 - 9 * 50_000)
    // 寫入單日最高 17,967 未達 2 萬、刪除更少、存量在免費額內 → 量測到的錢全在讀取
    expect(r.totals.writeCostUsd).toBe(0)
    expect(r.totals.deleteCostUsd).toBe(0)
    expect(r.totals.storageCostUsd).toBe(0)
    expect(r.totals.fileStorageCostUsd).toBe(0)
    expect(r.totals.measuredCostUsd).toBeCloseTo(0.8236, 3)

    // 校準：量測 0.82 ＋ 估算流量 0.21 ＝ 1.03，對照主控台當時顯示 NT$31.76
    // （帳單幣別為台幣，約當 US$1.03）→ 誤差 5% 內，證明「1 KB／筆」的假設站得住
    expect(r.totals.egressCostUsd).toBeCloseTo(0.2086, 3)
    expect(r.totals.totalCostUsd).toBeCloseTo(1.032, 2)

    // 錢是哪幾天花的：8/4 > 8/7 > 8/5（與主控台曲線的陡升段吻合）
    expect(r.topDays.map(d => d.day)).toEqual(['2026-08-04', '2026-08-07', '2026-08-05'])
  })
})
