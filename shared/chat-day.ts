/**
 * 訊息流的「日期分段」。
 *
 * 仿 LINE：對話不是一長條，而是照天切段，每段上面一顆置中的日期膠囊。
 * 少了這個，客服往上滑就分不出「這句是今天問的還是上個月問的」——
 * 泡泡旁只有時分（後台的 formatClockTime），日期一律由分隔線負責，兩邊不重複講。
 *
 * 一律用「看的人的當地時間」判斷跨日，不做時區換算：分隔線要對上客服自己牆上的時鐘，
 * 而不是伺服器的 UTC 午夜（後台跑在瀏覽器端，new Date() 就是本地時區）。
 */

/** 本地時區的 YYYY-MM-DD。跨日只比這個字串，不比時間差（差 24 小時 ≠ 跨一天） */
export function chatDayKey(ms: number): string {
  const d = new Date(ms)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * 分隔線上的字。
 *
 * · 今天／昨天 → 直接講白話。客服最常看的就是這兩天，
 *   要他在腦裡把「8月7日」換算成「這是今天嗎」是多一道工。
 * · 同一年 → `8月5日(三)`，和 LINE 一樣帶星期（排班、週末沒回都靠星期看出來）。
 * · 跨年才補年份 → 否則一整排日期被年份撐開，反而不好掃。
 *
 * nowMs 可注入，方便測試與避免午夜前後兩次呼叫拿到不同基準。
 */
export function formatChatDayLabel(ms: number, nowMs: number = Date.now()): string {
  const d = new Date(ms)
  const now = new Date(nowMs)
  const key = chatDayKey(ms)
  if (key === chatDayKey(nowMs)) return '今天'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (key === chatDayKey(yesterday.getTime())) return '昨天'
  const weekday = '日一二三四五六'[d.getDay()] ?? ''
  const md = `${d.getMonth() + 1}月${d.getDate()}日(${weekday})`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`
}
