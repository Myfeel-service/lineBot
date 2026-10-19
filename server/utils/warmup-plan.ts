import { taipeiHour } from '~~/shared/time'

/**
 * 保溫要同時佔住幾台主機（`/api/warmup` 的子保溫數，`D-47`②，2026-10-20 老闆照建議）。
 *
 * 白天：母請求＋3 個子請求＝4 台一起熱著（`D-10` 08-22 拍板保留：客人第一次點進來 2.3 秒→0.14 秒值這個錢）。
 * 半夜（台北 01:00–07:00）：只留母請求，子請求一個都不發。
 *
 * 省的是什麼：Amplify 的主機按「請求數＋執行秒數×記憶體」收費；每個子請求就是**一台主機被佔住一段時間**
 * （它在那段時間暖兩條頁面渲染＋讀一筆資料庫）。半夜沒有客人也沒人在後台，那 6 小時多熱著的 3 台是純浪費。
 * 子保溫一整月約 NT$254（`D-47` 用 8 月整月實數修正的數字），6／24 的時段＝約省 NT$60／月。
 * 代價：半夜同時有兩位以上客人時，第二位起可能落到冷的那台，多等約 0.3～1.4 秒（第一位落在母請求暖著的那台，不受影響）。
 * ⛔ 外部排程本身（Cloud Scheduler 多久打一次）不在 repo、也不要為了這個去改（`C-59` 定調不開新排程任務）。
 */
export const WARM_CHILDREN = 3
/** 半夜的子保溫數：0＝只保母請求 */
export const WARM_CHILDREN_OFF_PEAK = 0
/** 半夜＝台北 [from, to) 點（01:00 起、07:00 前） */
export const OFF_PEAK_TAIPEI_HOURS = { from: 1, to: 7 } as const

export function isWarmupOffPeak(now: Date = new Date()): boolean {
  const h = taipeiHour(now)
  return h >= OFF_PEAK_TAIPEI_HOURS.from && h < OFF_PEAK_TAIPEI_HOURS.to
}

/** 這一輪要發幾個子保溫 */
export function warmChildrenAt(now: Date = new Date()): number {
  return isWarmupOffPeak(now) ? WARM_CHILDREN_OFF_PEAK : WARM_CHILDREN
}
