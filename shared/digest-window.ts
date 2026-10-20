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
import { addDays, daysBetween, isServiceDayOff, type ServiceHoursLike } from './time'

/** 一次最多回看幾天（春節 9 天加前後週末也夠） */
export const DIGEST_COVER_MAX_DAYS = 14

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/** 那一天的台北中午（拿來問「這天休不休」，避開日界線） */
function noonOf(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00+08:00`)
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
    if (!isServiceDayOff(serviceHours, noonOf(key))) break
  }
  return days
}

/** 「2026-10-16」→「10/16（五）」 */
export function mdw(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return dateKey
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAY[d.getUTCDay()]}）`
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
 * 「本週顧客觀察」今天附不附：今天是這週**第一個會傳摘要的日子**。
 * 平常就是週一；週一放假（例如 2026-10-26 光復節補假）就換週二附，不然那一週就沒了。
 * 呼叫端已經擋掉「今天休假」，這裡只看這週一到昨天是不是全都休。
 */
export function isFirstDigestDayOfWeek(serviceHours: ServiceHoursLike | null | undefined, todayKey: string): boolean {
  const monday = mondayOf(todayKey)
  if (todayKey === monday) return true
  // 上一個會傳的日子在這週一之前＝這週一到昨天全都休
  return digestCoverDays(serviceHours, todayKey)[0]! < monday
}
