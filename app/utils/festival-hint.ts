/**
 * 「節日快到了」的後台版（2026-08-28 老闆拍板：節慶提醒不再只在 LINE）。
 *
 * LINE 那則是**一次性**的（7／3／1 天各講一次，講過就記在 cronState 不重講）；
 * 後台這個是**常駐**的——進入 7 天窗內就一直顯示，人哪天打開後台哪天看得到。
 * 兩邊共用同一張節日表與同一套文案（shared/taiwan-festivals.ts），⛔別在這裡
 * 另寫一份日期或句子——節日表一年校一次，寫兩份就是兩份要校。
 *
 * 純函式吃「台北的今天」字串，抽在 utils 是為了**測得到**（元件的 computed 沒有
 * 測試守著；而這個東西的失效方式是「該出現的沒出現」，畫面上跟平常一模一樣）。
 */
import { festivalReminderText, pickFestivalReminder } from '~~/shared/taiwan-festivals'

export interface FestivalHint {
  /** 節日名稱（給標題／aria 用） */
  name: string
  /** 完整那句話——跟 LINE 上是同一句（同一支文案函式產的） */
  text: string
  /** 距離節日幾天（0＝今天） */
  daysUntil: number
}

/** 今天（台北）有沒有節日在 7 天窗內。沒有回 null，元件整塊不渲染。 */
export function festivalHint(todayTaipei: string): FestivalHint | null {
  // sent 傳空物件＝不管 LINE 那邊講過沒有：後台是常駐顯示，語氣照剩餘天數自動換檔
  const r = pickFestivalReminder(todayTaipei, {})
  if (!r) return null
  return { name: r.festival.name, text: festivalReminderText(r), daysUntil: r.daysUntil }
}
