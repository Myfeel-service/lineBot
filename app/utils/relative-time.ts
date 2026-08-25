/**
 * 「多久以前」。後台好幾處都要這一句，先前是各自複製一份——
 * 複製品遲早會有人只改其中一份，同一個時間在兩頁顯示不一樣。
 *
 * 超過一天就改印日期：「31 小時前」要在腦中換算成哪一天，不如直接給日期。
 */
export function relativeTime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '剛剛'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`
  return calendarDate(ms)
}

/**
 * 「放多久了」——**經過的時間**，跟 relativeTime 是兩個不同的問題。
 *
 * `relativeTime` 超過一天就改印日期，理由寫在它自己的註解裡：訊息時間軸要回答的是
 * 「這是哪一天的事」，「31 小時前」還要在腦中換算。但**陳放時間**要回答的是
 * 「這件事擱著多久了」——印「8/4」等於把換算丟回給讀者，正是它想避免的事。
 *
 * 實例（08-25 code review 抓到）：AI 標籤建議約每週產生一次，所以打開頁面時它幾乎
 * 永遠超過 24 小時 → 本來想講「放三週沒人動」，實際印出來是「8/4提議」。
 *
 * ⛔ 不要為了「統一」把這支併回 relativeTime：兩支回答不同問題，併了會讓訊息時間
 *    變成「37 天前」那種要自己數日曆的東西。
 */
export function elapsedSince(ms: number, now: number = Date.now()): string {
  if (!ms) return ''
  const diff = now - ms
  if (diff < 0) return '剛剛'
  if (diff < 60_000) return '剛剛'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`
  const days = Math.floor(diff / 86_400_000)
  if (days < 14) return `${days} 天前`
  const weeks = Math.floor(days / 7)
  if (weeks < 9) return `${weeks} 週前`
  return `${Math.floor(days / 30)} 個月前`
}

/**
 * 日曆日期的統一寫法：**今年只印月日、跨年才補上年份**。
 *
 * 為什麼要有這一支（G-27⑥）：客人卡上「加入於 2026/8/23」印完整年月日、
 * 「最後來訊 8/23」只印月日——同一張卡兩種寫法，老闆一眼就看出來不對齊。
 *
 * 補年份的規則不是為了整齊而已，它同時修掉一個真的會誤讀的地方：
 * 舊寫法對**去年**的 8/23 也只印「8/23」，看起來就像上週的事。
 *
 * ⛔ 用 toLocaleDateString 拿年份會拿到字串，要比對得先 parse；
 *    直接用 getFullYear 比，時區一致（兩邊都是瀏覽器本地時間）。
 */
export function calendarDate(ms: number, now: number = Date.now()): string {
  if (!ms) return ''
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('zh-TW', sameYear
    ? { month: 'numeric', day: 'numeric' }
    : { year: 'numeric', month: 'numeric', day: 'numeric' })
}
