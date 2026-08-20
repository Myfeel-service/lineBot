/**
 * 台灣時區（Asia/Taipei）與日曆運算工具。
 *
 * 台灣固定 UTC+8、無日光節約,故「位移 8 小時後讀 UTC 欄位」即得台灣民用日期,
 * 不需時區資料庫。
 *
 * ⚠️ 這裡有兩把**用途不同、刻意不對齊**的尺,不要混用：
 *
 *   · `taipeiYyyyMm` —— **成本報表**的月結桶（`aiUsage/{ws}_{yyyyMM}`）。固定對齊日曆月,
 *     因為報表要能按月比較、對得上財務期間。
 *
 *   · `anchoredPeriod` —— **訂閱週期與則數額度**。對齊「錨定日」（客戶開始訂閱的那天）:
 *     7/28 訂閱 → 7/28~8/27 → 8/28~9/27。額度隨這把尺重置,不是每月 1 號。
 *
 * 兩把尺分開,是為了讓「月底才升級的人」不會付了整月的錢只買到幾天、額度還被
 * 同月份的免費用量吃掉。報表歸報表,計費歸計費。
 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000

const p2 = (n: number) => String(n).padStart(2, '0')

/** 台灣時區下的 yyyyMM（**成本報表**月結桶的鍵；不要拿來算額度週期）。 */
export function taipeiYyyyMm(date: Date = new Date()): string {
  const t = new Date(date.getTime() + TAIPEI_OFFSET_MS)
  return `${t.getUTCFullYear()}${p2(t.getUTCMonth() + 1)}`
}

/** 台灣時區下的今天（YYYY-MM-DD）。所有週期比對都以這個字串為準。 */
export function taipeiDate(date: Date = new Date()): string {
  const t = new Date(date.getTime() + TAIPEI_OFFSET_MS)
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`
}

// ── 日曆運算（純 YYYY-MM-DD 字串運算，不涉時區）──────────────────────

/** 取日期字串的「日」（1–31）。 */
export function dayOfDate(date: string): number {
  return Number(date.slice(8, 10))
}

/** 日期字串 ± n 天。 */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`
}

/**
 * 兩個日期字串相差幾天（`to - from`，`to` 比較晚就是正數）。
 *
 * 刻意用 `Date.UTC` 而不是把字串當本地時間 parse：後者在 UTC+8 以外的執行環境
 * （CI、開發機）會因為 parse 出來的時間點落在前一天而整批偏移一天。
 */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/** 錨定日合法化：夾到 1–31。 */
export function normalizeAnchorDay(day: number | null | undefined): number {
  const n = Math.floor(Number(day) || 1)
  return Math.min(31, Math.max(1, n))
}

/** 某年某月（0-based）實際能落在的錨定日：短月夾到當月最後一天。 */
function anchorDayInMonth(year: number, month0: number, anchorDay: number): number {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
  return Math.min(anchorDay, lastDay)
}

/** 一期的起訖（YYYY-MM-DD，**起訖皆含當日**）。 */
export interface BillingPeriod {
  start: string
  end: string
}

/**
 * 從 `start` 起算的一期：結束於「下一次錨定日的前一天」。
 *
 * 錨定日遇短月會夾到當月最後一天（錨定日 31 → 2 月當成 28/29）,但 `anchorDay` 本身
 * 不變,所以下個月會回到原本的日子——1/31 → 2/28 → 3/31,不會每經過一個短月就永久
 * 往前漂一天。這就是「錨定日必須單獨存起來、不能從上一期的起日反推」的原因。
 */
export function anchoredPeriod(start: string, anchorDay: number): BillingPeriod {
  const day = normalizeAnchorDay(anchorDay)
  const [y, m, d] = start.split('-').map(Number) as [number, number, number]

  let year = y
  let month0 = m - 1
  // 本月的錨定日還在 start 之後（例如期中降級,start 是今天）→ 這一期就在本月結束;
  // 否則（一般情況:start 正好落在錨定日）→ 下一次錨定日在下個月。
  if (d >= anchorDayInMonth(year, month0, day)) {
    month0 += 1
    if (month0 > 11) {
      month0 = 0
      year += 1
    }
  }

  const anchor = `${year}-${p2(month0 + 1)}-${p2(anchorDayInMonth(year, month0, day))}`
  return { start, end: addDays(anchor, -1) }
}

/** 下一期：接在本期到期日的隔天,兩期之間不留空隙也不重疊。 */
export function nextAnchoredPeriod(period: BillingPeriod, anchorDay: number): BillingPeriod {
  return anchoredPeriod(addDays(period.end, 1), anchorDay)
}

// ── 服務時間 / 勿擾時段（台灣時區）────────────────────────────────────

/** isServiceHoursDnd 需要的最小設定形狀（結構化型別，避免耦合 ai-knowledge）。 */
export interface ServiceHoursLike {
  enabled: boolean
  /** "HH:mm" 台灣時區 */
  start: string
  /** "HH:mm" */
  end: string
  /** 週六日整天視為勿擾 */
  weekendOff: boolean
}

/** "HH:mm" → 午夜起算的分鐘；格式不合回 null。 */
function hhmmToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * 今天（台灣時區）是不是「整天不上班」的日子＝開了服務時間又勾了週六日休息的週末。
 *
 * 和 `isServiceHoursDnd` 刻意分開:勿擾是「現在這個時間點不要吵」,休假日是「今天整天
 * 沒人上班」。每日摘要這種**商家自選時段**的推播只能看後者——若拿整個勿擾去擋,
 * 摘要時間設 20:00 而服務時間到 18:00 的商家會永遠收不到摘要。
 */
export function isServiceDayOff(cfg: ServiceHoursLike | null | undefined, date: Date = new Date()): boolean {
  if (!cfg?.enabled || !cfg.weekendOff) return false
  const dow = new Date(date.getTime() + TAIPEI_OFFSET_MS).getUTCDay() // 0=Sun … 6=Sat（已位移為台灣時區）
  return dow === 0 || dow === 6
}

/**
 * 現在（台灣時區）是否落在「勿擾時段」＝服務時間之外。
 * - enabled=false 一律回 false（完全不影響行為）。
 * - weekendOff 時,台灣時區的週六/週日整天視為勿擾。
 * - 服務時段支援跨夜（start > end，例如 22:00–06:00）。
 * - 設定壞掉（start/end 非法）→ 回 false，寧可不擋也不要誤擋正常轉真人。
 */
export function isServiceHoursDnd(cfg: ServiceHoursLike | null | undefined, date: Date = new Date()): boolean {
  if (!cfg?.enabled) return false
  if (isServiceDayOff(cfg, date)) return true
  const t = new Date(date.getTime() + TAIPEI_OFFSET_MS)
  const start = hhmmToMinutes(cfg.start)
  const end = hhmmToMinutes(cfg.end)
  if (start === null || end === null) return false
  const nowMin = t.getUTCHours() * 60 + t.getUTCMinutes()
  const inService = start <= end
    ? (nowMin >= start && nowMin < end) // 一般 09:00–18:00
    : (nowMin >= start || nowMin < end) // 跨夜 22:00–06:00
  return !inService
}
