/**
 * 每日摘要「這一則要講哪幾天」（`D-137`①，2026-10-21）。
 *
 * 為什麼要有：休假日（勾了休息的週末、國定假日）整天不傳摘要，而摘要原本只講「昨天」。
 * 週五早上那則講週四 → 週六日不傳 → 週一講週日：**週五、週六的成績從來沒有被講過**
 * （MYFEEL 9/17～10/19 共 854 場，200 場落在這兩天）。連假更長，回來那天只講最後一天。
 *
 * 規則：從上一個「有傳摘要的日子」那天起，講到昨天。那天傳的那則講的是它的前一天，
 * 所以它自己那天、以及之後的休假日，都還沒被講過。平常就是昨天一天。
 *
 * ⛔ **LINE 摘要與後台小幫手那張卡一定要用這一支**：一邊講 3 天、一邊講 1 天，
 *    就是「LINE 說 84 場、後台說 27 場」——8 月那次「兩邊數字對不上、懷疑有 bug」再來一次。
 * ⛔ 用日曆推（照休假日規則），不看那天實際有沒有送出去：後台卡讀不到送出紀錄，
 *    兩邊要算得出同一段日子。某天送失敗的那段不補（很少見，當天會一直重試）。
 */
import { addDays, daysBetween, isServiceDayOff, mdw, type ServiceHoursLike } from './time'

/** 一次最多回看幾天（春節 9 天加前後週末也夠） */
export const DIGEST_COVER_MAX_DAYS = 14

/** 這一天整天不傳摘要（勾了休息的週末／國定假日）。用那天的台北中午問，避開日界線 */
export function isDigestDayOff(serviceHours: ServiceHoursLike | null | undefined, dateKey: string): boolean {
  return isServiceDayOff(serviceHours, new Date(`${dateKey}T12:00:00+08:00`))
}

/**
 * 今天這則摘要要講的日子（由舊到新，最後一天一定是昨天）。
 * 沒開服務時間、或沒勾任何休息 → 永遠只有昨天。
 */
export function digestCoverDays(serviceHours: ServiceHoursLike | null | undefined, todayKey: string): string[] {
  const days: string[] = []
  for (let i = 1; i <= DIGEST_COVER_MAX_DAYS; i++) {
    const key = addDays(todayKey, -i)
    days.unshift(key)
    if (!isDigestDayOff(serviceHours, key)) break
  }
  return days
}

/**
 * 「比較」那一段（後台卡）：單日比前天；好幾天比**往前整數週**的同一段——週五～週日比上週五～週日，
 * 平日跟週末不混著比。⛔ 超過 7 天（春節）不可以只退 7 天：比較的那段會跟這段重疊、同一天兩邊都算到，
 * 所以退到不重疊為止（8～14 天退兩週），標籤跟著講「兩週前」。
 */
export function digestCompareRange(startKey: string, endKey: string): { startDate: string, endDate: string, label: string } {
  const days = daysBetween(startKey, endKey) + 1
  if (days <= 1) return { startDate: addDays(startKey, -1), endDate: addDays(startKey, -1), label: '前天' }
  const weeks = Math.ceil(days / 7)
  return {
    startDate: addDays(startKey, -7 * weeks),
    endDate: addDays(endKey, -7 * weeks),
    label: weeks === 1 ? '上週同期' : weeks === 2 ? '兩週前同期' : `${weeks} 週前同期`,
  }
}

/** LINE 那句的主詞：「10/16（五）到 10/18（日）這 3 天」 */
export function coverPhrase(days: readonly string[]): string {
  return `${mdw(days[0]!)}到 ${mdw(days[days.length - 1]!)}這 ${days.length} 天`
}

/** 後台卡的標題：「10/16（五）～10/18（日）3 天」 */
export function coverTitle(startKey: string, endKey: string): string {
  return `${mdw(startKey)}～${mdw(endKey)}${daysBetween(startKey, endKey) + 1} 天`
}

/** 那一週的週一（YYYY-MM-DD） */
export function mondayOf(dateKey: string): string {
  const dow = new Date(`${dateKey}T00:00:00Z`).getUTCDay()
  return addDays(dateKey, -((dow + 6) % 7))
}

/**
 * 今天這則要附哪幾週的「本週顧客觀察」（每一週用它的週一當錨，由舊到新；空陣列＝今天不附）。
 *
 * 規則＝上一則摘要之後、到今天為止經過的每一個週一。平常就是週一附一份；週一放假（2026-10-26 光復節補假）
 * 就換週二附；**整週都放假**（春節）那一週的週一也在這段裡，下一則一起附——只看「這週」的話，
 * 整週沒傳過摘要的那一週就整份沒了。呼叫端已經擋掉「今天休假」。
 */
export function weeklyInsightMondays(serviceHours: ServiceHoursLike | null | undefined, todayKey: string): string[] {
  // 這段的第一天＝上一則摘要傳出的那天（見 digestCoverDays），它那天經過的週一它自己已經附過
  const lastSent = digestCoverDays(serviceHours, todayKey)[0]!
  const mondays: string[] = []
  for (let m = mondayOf(todayKey); m > lastSent; m = addDays(m, -7)) mondays.unshift(m)
  return mondays
}
