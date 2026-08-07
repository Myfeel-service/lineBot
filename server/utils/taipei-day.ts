/**
 * 統計／清單的 `YYYY-MM-DD` 日期參數一律視為**台北牆上時間**的日界線。
 * （慣例同 broadcast-schedule.ts：「無時區字串視為 Asia/Taipei 牆上時間、與後台 date-picker 一致」）
 *
 * 為什麼不能用 `new Date('YYYY-MM-DD')` + `setHours(23,59,59)`：
 * 前者是 UTC 半夜、後者吃**伺服器**時區。部署在 UTC Lambda 上，「8/6」的查詢窗
 * 實際會變成台北 8/6 08:00 ～ 8/7 07:59——昨日摘要因此把隔天凌晨的場次算進昨天
 * （2026-08-07 實測：同一天正式環境 18 場、本機 16 場，差的 2 場全是 8/7 凌晨開的）。
 * 本機（台北時區）跑起來又是另一個窗（8/6 08:00 ～ 23:59），兩邊都錯而且錯得不一樣。
 *
 * 固定 +8：台灣沒有夏令時間。若日後要支援其他時區的租戶，
 * 放 per-workspace 設定再傳進來，不要改這裡的預設。
 */
export const TAIPEI_OFFSET_MS = 8 * 3600_000

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM-DD` → 該日台北 00:00:00.000 的絕對時刻；格式不對回 null（呼叫端當作沒帶） */
export function taipeiDayStart(value: unknown): Date | null {
  const m = DAY_RE.exec(String(value ?? '').trim())
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - TAIPEI_OFFSET_MS
  return Number.isNaN(ms) ? null : new Date(ms)
}

/** `YYYY-MM-DD` → 該日台北 23:59:59.999 的絕對時刻 */
export function taipeiDayEnd(value: unknown): Date | null {
  const start = taipeiDayStart(value)
  return start ? new Date(start.getTime() + 24 * 3600_000 - 1) : null
}

/**
 * 絕對時刻 → 台北日曆上的分量。回傳的 Date 是「把台北牆上時間假裝成 UTC」的載體，
 * **只能用 getUTC* 系列讀**（getFullYear/getDate 會再吃一次執行環境時區，就白修了）。
 */
export function shiftToTaipei(d: Date): Date {
  return new Date(d.getTime() + TAIPEI_OFFSET_MS)
}

/** 絕對時刻 → 台北日期字串 `YYYY-MM-DD`（趨勢分桶、日報 key 用） */
export function taipeiDateKey(d: Date): string {
  return shiftToTaipei(d).toISOString().slice(0, 10)
}
