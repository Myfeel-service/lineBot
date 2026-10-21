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
import { taiwanHolidayName } from './taiwan-holidays'

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

/** 台灣時區下現在幾點（0–23）。 */
export function taipeiHour(date: Date = new Date()): number {
  return new Date(date.getTime() + TAIPEI_OFFSET_MS).getUTCHours()
}

/** 星期幾的中文（`getUTCDay()` 的順序：0＝日） */
export const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'] as const

/**
 * 「2026-10-16」→「10/16（五）」。日期字串不含時區 → 當 UTC 午夜解析，`getUTCDay` 就是那個日曆日的星期幾
 * （不要換成本機時區）。⛔ 要講「幾月幾號星期幾」的地方都走這支，不要各自再拼一份。
 */
export function mdw(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return dateKey
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAY_ZH[d.getUTCDay()]}）`
}

/**
 * 台灣時區下的「YYYY-MM-DD HH:mm」——講給人看的時間點。
 *
 * ⛔ 需要這個的地方不要各自手寫 `new Date(ms + 8h).toISOString()`：
 *    那串東西每抄一次就多一份 2026-08-07 時區 bug 的形狀，
 *    以後要修得先把散落各處的抄本全部找出來。
 */
export function taipeiDateTime(ms: number): string {
  const t = new Date(ms + TAIPEI_OFFSET_MS)
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())} ${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}`
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
  /**
   * 國定假日（含補假，表在 `taiwan-holidays.ts`）整天視為勿擾（`D-137`②）。
   * 沒帶＝跟 `weekendOff` 一樣（見 `holidayOffOf`）：週末休息的店，國定假日幾乎也休。
   */
  holidayOff?: boolean
}

/** 國定假日休不休。沒設過（舊資料）＝跟週末一樣 */
export function holidayOffOf(cfg: ServiceHoursLike | null | undefined): boolean {
  return cfg?.holidayOff ?? cfg?.weekendOff ?? false
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
 * 今天（台灣時區）是不是「整天不上班」的日子＝開了服務時間，而且今天是勾了休息的週末或國定假日。
 *
 * 和 `isServiceHoursDnd` 刻意分開:勿擾是「現在這個時間點不要吵」,休假日是「今天整天
 * 沒人上班」。每日摘要這種**商家自選時段**的推播只能看後者——若拿整個勿擾去擋,
 * 摘要時間設 20:00 而服務時間到 18:00 的商家會永遠收不到摘要。
 */
export function isServiceDayOff(cfg: ServiceHoursLike | null | undefined, date: Date = new Date()): boolean {
  if (!cfg?.enabled) return false
  if (holidayOffOf(cfg) && taiwanHolidayName(taipeiDate(date))) return true
  if (!cfg.weekendOff) return false
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

/**
 * 服務時間講成一句人話：「週一至週五 10:00–19:00」／「每天 10:00–19:00」。
 *
 * 為什麼要有這句：勿擾訊息只說「目前非客服服務時間」，客人**無從得知要等多久**——
 * 2026-08-24 那位客人收到之後在 41 秒內按了 34 次選單，因為他不知道是要等到明天早上
 * 還是訊息根本沒送出去（`H-19`）。給一個明確的時間，等待才變成可以接受的事。
 *
 * 三種情況回 null（呼叫端就不要接這句）：沒開、時間格式壞掉、起訖同一分鐘。
 * 寧可少講一句，也不要對客人講出「週一至週五 undefined」或「每天 09:00–09:00」
 * ——後者是 isServiceHoursDnd 眼中的「整天都不服務」，照字面唸出來只會讓客人更困惑。
 */
export function serviceHoursSentence(cfg: ServiceHoursLike | null | undefined): string | null {
  if (!cfg?.enabled) return null
  const start = hhmmToMinutes(cfg.start)
  const end = hhmmToMinutes(cfg.end)
  if (start === null || end === null) return null
  if (start === end) return null
  const days = cfg.weekendOff ? '週一至週五' : '每天'
  const holiday = holidayOffOf(cfg) ? '（國定假日休息）' : ''
  // 用整理過的字串而不是原值：設定存的是 "9:00" 也要講成 "09:00"
  return `${days} ${minutesToHhmm(start)}–${minutesToHhmm(end)}${holiday}`
}

/**
 * 下一次開始服務的時間點（毫秒）＝勿擾結束、找真人會通知同事的那一刻；現在就在服務時間內回 `nowMs`，
 * 沒開／設定壞掉回 `null`。
 *
 * 每天看兩個時間點：服務開始那一刻、以及**午夜**。跨夜的服務時間（22:00–06:00）放假那天整天勿擾，
 * 隔天一過午夜就回到「06:00 以前算上班」——只看開始時間會講成隔天 22:00，比同事真的被通知晚了快一整天。
 * ⛔ 不要自己推「哪一段算上班」，一律問 `isServiceHoursDnd`：講給客人的時間跟真的通知同事的時間只能有一把尺。
 * 跨夜那一班遇到放假：照日曆日算（10/8 晚上那班過了午夜進到 10/9 國定假日就勿擾），跟週末一向的算法相同。
 *
 * @param opts.ignoreHolidays 當作國定假日照常上班來算——拿來比較「是不是因為放假才等這麼久」
 */
export function nextServiceStartMs(
  cfg: ServiceHoursLike | null | undefined,
  nowMs: number,
  opts: { ignoreHolidays?: boolean } = {},
): number | null {
  if (!cfg?.enabled) return null
  const start = hhmmToMinutes(cfg.start)
  const end = hhmmToMinutes(cfg.end)
  if (start === null || end === null || start === end) return null
  const c: ServiceHoursLike = opts.ignoreHolidays ? { ...cfg, holidayOff: false } : cfg
  if (!isServiceHoursDnd(c, new Date(nowMs))) return nowMs
  const today = taipeiDate(new Date(nowMs))
  // 春節最長 9 天，加上前後週末；給到 31 天綽綽有餘
  for (let i = 0; i <= 31; i++) {
    const midnight = Date.parse(`${addDays(today, i)}T00:00:00+08:00`)
    for (const t of [midnight, midnight + start * 60_000]) {
      if (t > nowMs && !isServiceHoursDnd(c, new Date(t))) return t
    }
  }
  return null
}

/**
 * 在勿擾訊息後面補一行實際的服務時間（客人找真人、遇到勿擾時收到的那則；2026-10-21 從 handler 搬來好測）。
 *
 * 為什麼由程式補、不是叫店家自己寫進去：①店家改了營業時間只會改上面的時間欄位，
 * 手寫在文案裡的那句會留在原地變成假資訊 ②預設文案（`DEFAULT_DND_REPLY`）本來就只說
 * 「會在服務時間盡快回覆」，沒開口講服務時間是幾點——客人無從判斷要等 10 分鐘還是
 * 到明天早上，只好一直重按（`H-19`）。
 *
 * ⛔ 店家自己已經寫了時間就不補：用「文案裡有沒有出現那個開始時間」判斷。
 *    寧可漏補一次，也不要送出「…10:00–19:00 回覆您。服務時間：週一至週五 10:00–19:00」。
 *
 * **因為國定假日才要等更久時，改講下次幾號幾點**（`D-137`②）：國定假日的週五讀到「服務時間：
 * 週一至週五」會覺得「今天週五啊」；放假前一晚、假日前的週末，照那句推出來的時間也是錯的。
 * 判斷＝「照放假算的下次上班」比「當作國定假日照常上班算的」晚。這句不看店家文案裡寫了什麼時間
 * ——講的是日期，店家的文案不會知道今年哪天放假。
 */
export function appendServiceHoursLine(base: string, cfg: ServiceHoursLike | null | undefined, nowMs = Date.now()): string {
  const next = nextServiceStartMs(cfg, nowMs)
  const nextIgnoringHolidays = nextServiceStartMs(cfg, nowMs, { ignoreHolidays: true })
  if (next !== null && nextIgnoringHolidays !== null && next > nextIgnoringHolidays)
    return `${base}\n國定假日休息，${taipeiMdwHm(next)} 起回覆您。`

  const sentence = serviceHoursSentence(cfg)
  if (!sentence) return base
  const startHhmm = sentence.split(' ')[1]?.split('–')[0] ?? ''
  if (startHhmm && base.includes(startHhmm)) return base
  return `${base}\n服務時間：${sentence}`
}

/** 時間點講成「10/12（一）10:00」 */
export function taipeiMdwHm(ms: number): string {
  const t = new Date(ms + TAIPEI_OFFSET_MS)
  return `${mdw(taipeiDate(new Date(ms)))}${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}`
}

/**
 * 勿擾時段講成一句人話：「19:00–10:00，以及週六、週日整天」。
 *
 * ⛔ **設定裡存的是「服務時間」，勿擾是它的補集**——兩者的起訖剛好顛倒。
 *    2026-09-18 壓測踩到：小幫手被問「勿擾時段是幾點到幾點」，直接把設定裡的
 *    `start:10:00 / end:19:00` 唸成「勿擾 10:00–19:00」，正好把上班時間講成不打擾的時間。
 *    所以凡是要把這個設定講給人聽的地方，一律走這支與 `serviceHoursSentence`，
 *    ⛔ 不要在各自的地方自己換算（提議那條路的註解早就寫過「換錯會把上下班時間顛倒」）。
 */
export function dndSentence(cfg: ServiceHoursLike | null | undefined): string {
  if (!cfg?.enabled) return '目前沒有勿擾時段（任何時間找真人都會通知）'
  const days = [cfg.weekendOff ? '週六、週日' : '', holidayOffOf(cfg) ? '國定假日' : ''].filter(Boolean)
  const weekend = days.length ? `，以及${days.join('與')}整天` : ''
  return `${cfg.end}–${cfg.start}${weekend}`
}

/** 午夜起算的分鐘 → "HH:mm"（補零，和設定畫面顯示的一致）。 */
function minutesToHhmm(total: number): string {
  return `${p2(Math.floor(total / 60))}:${p2(total % 60)}`
}
