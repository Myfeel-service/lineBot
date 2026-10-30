/** 與 Cron 每分鐘觸發對齊（前後端共用） */
export const BROADCAST_SCHEDULE_MIN_LEAD_MS = 60_000

/**
 * 「10/31 下午6:00」：推播幾點送（台灣時間、不印年跟秒）。
 * 推播清單、排程那一格的說明、小幫手提醒（`C-433`）共用——同一個時間不要兩種寫法。
 * ⛔ 日期跟時間中間 Node 22 給的是窄空白（U+2009），瀏覽器版本不同可能給別的：一律換成一般空白，主機跟畫面才一個字都不差
 */
export function broadcastSendAtText(d: Date): string {
  return d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Taipei' })
    .replace(/\s+/g, ' ')
}

/** 後台 date-picker 的本地時間字串 → UTC ISO（送 API 用） */
export function localDateTimeInputToUtcIso(input: string): string | null {
  const raw = String(input || '').trim()
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/** 表單驗證：排程是否為有效未來時間 */
export function validateFutureScheduleLocalInput(input: string): string | null {
  const raw = String(input || '').trim()
  if (!raw) return '請選擇排程時間'
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return '排程時間格式不正確'
  if (d.getTime() <= Date.now() + BROADCAST_SCHEDULE_MIN_LEAD_MS) {
    return '排程時間須至少一分鐘後'
  }
  return null
}
