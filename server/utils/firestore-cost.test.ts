import { describe, it, expect } from 'vitest'
import { computeFirebaseCost, FIRESTORE_FREE_TIER, FREE_EGRESS_GIB_PER_MONTH, GIB, type DayUsage } from './firestore-cost'

const day = (d: string, over: Partial<DayUsage> = {}): DayUsage => ({
  day: d, reads: 0, writes: 0, deletes: 0, storageBytes: 0, fileBytes: 0, ...over,
})

/** 每筆 1 KB 時，讀幾次剛好傳出 n GiB */
const readsForGib = (n: number) => n * GIB / 1024

describe('computeFirebaseCost', () => {
  it('免費額度內全部是 0：每日讀寫刪＋存量＋每月 10 GiB 流量都沒超過', () => {
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
    // 流量照樣算出量來（畫面要講「傳了多少」），只是落在每月免費額內
    expect(r.totals.egressGib).toBeGreaterThan(0)
    expect(r.totals.billableEgressGib).toBe(0)
    expect(r.totals.egressCostUsd).toBe(0)
    expect(r.totals.totalCostUsd).toBe(0)
  })

  it('流量費＝超過每月 10 GiB 的部分 × 單價；免費的 5 萬次讀取一樣在傳資料，不能拿來扣流量', () => {
    // 一天傳 11 GiB → 超過 1 GiB → US$0.12
    const r = computeFirebaseCost([day('2026-08-01', { reads: readsForGib(FREE_EGRESS_GIB_PER_MONTH + 1) })], { multiRegion: true, daysInMonth: 31 })
    expect(r.totals.egressGib).toBeCloseTo(11, 6)
    expect(r.totals.billableEgressGib).toBeCloseTo(1, 6)
    expect(r.totals.egressCostUsd).toBeCloseTo(0.12, 6)

    // 假設值可調高以估得更保守：每筆 2 KB → 同樣讀取次數傳出 22 GiB、超過 12 GiB
    const conservative = computeFirebaseCost([day('2026-08-01', { reads: readsForGib(FREE_EGRESS_GIB_PER_MONTH + 1) })], { multiRegion: true, daysInMonth: 31, bytesPerRead: 2048 })
    expect(conservative.totals.egressCostUsd).toBeCloseTo(12 * 0.12, 6)
    // 量測的部分不會因為假設變動而改變
    expect(conservative.totals.measuredCostUsd).toBe(r.totals.measuredCostUsd)
  })

  it('流量免費額是「每月」累計、不是每天重置：月初那幾天吃掉免費額，之後每天都要錢', () => {
    // 每天 4 GiB × 4 天＝16 GiB：前兩天半吃掉 10 GiB，第 3 天收 2 GiB、第 4 天收 4 GiB
    const days = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']
      .map(d => day(d, { reads: readsForGib(4) }))
    const r = computeFirebaseCost(days, { multiRegion: true, daysInMonth: 31 })
    expect(r.totals.billableEgressGib).toBeCloseTo(6, 6)
    expect(r.totals.egressCostUsd).toBeCloseTo(6 * 0.12, 6)
    // 流量錢落在後面那兩天，不是平均攤在四天（長條圖上的金額標籤靠這個）
    const readCost = (readsForGib(4) - FIRESTORE_FREE_TIER.readsPerDay) / 100_000 * 0.06
    const daily = r.days.map(d => d.costUsd)
    expect(daily[0]).toBeCloseTo(readCost, 5)
    expect(daily[1]).toBeCloseTo(readCost, 5)
    expect(daily[2]).toBeCloseTo(readCost + 2 * 0.12, 5)
    expect(daily[3]).toBeCloseTo(readCost + 4 * 0.12, 5)
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
    // 讀到流量超過每月免費額，估算那一格才會是正數
    const r = computeFirebaseCost([day('2026-08-01', { reads: readsForGib(12) })], { multiRegion: true, daysInMonth: 31 })
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

    // 九天傳出約 1.74 GiB，整個落在每月 10 GiB 的免費流量內 → 流量 0 元。
    // ⛔ 2026-08-10 這裡曾斷言「量測 0.82 ＋ 流量 0.21 ＝ 1.03 ≈ 主控台 NT$31.76，誤差 5% 內」，
    //    拿來證明流量假設站得住——那是巧合：這 1.74 GiB 主控台根本不會收錢。
    //    9/7 那次對帳才看出來（扣掉流量後與主控台幾乎一致），見 FREE_EGRESS_GIB_PER_MONTH。
    expect(r.totals.egressGib).toBeCloseTo(1.738, 3)
    expect(r.totals.egressCostUsd).toBe(0)
    expect(r.totals.totalCostUsd).toBeCloseTo(0.8236, 3)

    // 錢是哪幾天花的：8/4 > 8/7 > 8/5（與主控台曲線的陡升段吻合）
    expect(r.topDays.map(d => d.day)).toEqual(['2026-08-04', '2026-08-07', '2026-08-05'])
  })
})
