/**
 * 店家自己的檔期（`D-122`②，2026-10-19 老闆「按你建議」）。
 *
 * ── 為什麼要有 ─────────────────────────────────────────────────
 * 「接下來的檔期」原本只懂國定節日，但店家真正在做的常常是自己的檔期：MYFEEL 2026-08～10
 * 的 14 則推播全是新品上市（「某某_超早鳥倒數」→「某某_開賣」），0 則節日推播，
 * 卡片最下面那一行就永遠寫「沒有為節日發的推播」。
 * 自己的檔期加進來之後，**跟節日一樣**：快到時攤開、可以擬推播、7／3／1 天前 LINE 提醒、
 * 發完在回顧裡看得到幾個人打開與點連結。
 *
 * ── 三條鐵律 ───────────────────────────────────────────────────
 * ① ⛔ **不從推播名稱猜檔期**：「超早鳥倒數」「開賣」是 MYFEEL 自己的命名習慣，別家不一定；
 *    猜錯了卡片上就多出一堆不是檔期的東西。只有兩個入口：卡片上「＋ 加自己的檔期」、
 *    推播頁一則**已排程**的推播「設成檔期」。
 * ② **只收卡片看得到的日子**（今天到 90 天內）：加了卻在卡片上看不到，等於加了就不見；
 *    過完的檔期只在回顧裡出現，改不到也刪不到，所以不收過去的日子。
 * ③ **id 帶 `own-` 前綴**：推播的 `festivalId`、「這次不做」、LINE 提醒的里程碑都用同一個 id，
 *    前綴讓「這是店家自己的」一眼分得出來，也不會跟節日表的 `{slug}-{西元年}` 撞號。
 *
 * 存法：`marketingCalendarEvents/{workspaceId}` 一份文件、`events` 一個 map（跟「這次不做」同一個理由：
 * 最多幾十筆、每次開卡都要整份讀，拆成一筆一份只是把一次讀取變成 N 次）。讀寫在 `server/utils/marketing-events.ts`。
 */

import { CALENDAR_WINDOW_DAYS } from './marketing-calendar'
import { addDays, daysBetween } from './time'
import type { TaiwanFestival } from './taiwan-festivals'

/** id 前綴（③）。⛔ 不可含「.」：id 會被當成 Firestore map 的 key */
export const OWN_EVENT_ID_PREFIX = 'own-'
/** 名稱最多幾個字。卡片的名字欄只有 108px，再長就要折好幾行 */
export const MARKETING_EVENT_NAME_MAX = 16
/** 一個帳號最多同時幾檔（還沒過、或過了還在回顧期裡的）。⛔ 不要讓一份文件無限長大 */
export const MARKETING_EVENTS_MAX = 30
/**
 * 過了多少天就不留。回顧往回看 90 天（`OUTCOME_LOOKBACK_DAYS`），多留一個月緩衝；
 * 再久的不會出現在任何地方，留著只是讓文件變肥。
 */
export const MARKETING_EVENT_KEEP_DAYS = 120

/** 存在 Firestore 的一筆（map 的 value；key 就是 id） */
export interface StoredMarketingEvent {
  name: string
  /** YYYY-MM-DD（台灣日期） */
  date: string
  createdAt: number
  updatedAt?: number
  /** 從推播頁「設成檔期」建的：那一則推播的 id（只是來歷，歸屬看推播上的 `festivalId`） */
  broadcastId?: string
}

export type MarketingEventMap = Record<string, StoredMarketingEvent>

export interface MarketingEvent extends StoredMarketingEvent {
  id: string
}

const ID_RE = /^own-[A-Za-z0-9-]{6,60}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 是不是自己的檔期的 id（節日表的 id 長得像 `midautumn-2026`，不會中）。 */
export function isOwnEventId(id: unknown): boolean {
  return typeof id === 'string' && ID_RE.test(id)
}

/** YYYY-MM-DD 而且是真的日子（⛔ 2026-02-30 這種會被 Date 默默挪到 3 月） */
export function isValidDateKey(date: unknown): date is string {
  if (typeof date !== 'string' || !DATE_RE.test(date)) return false
  return addDays(date, 0) === date
}

/** 名稱整理：去頭尾空白、連續空白收成一個 */
export function cleanEventName(name: unknown): string {
  return String(name ?? '').replace(/\s+/g, ' ').trim()
}

/** 把資料庫拿到的東西洗成乾淨的 map。⛔ 壞掉的一律丟掉，不要讓它炸掉整張卡。 */
export function normalizeEventMap(raw: unknown): MarketingEventMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: MarketingEventMap = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isOwnEventId(id) || !v || typeof v !== 'object') continue
    const e = v as Record<string, unknown>
    const name = cleanEventName(e.name).slice(0, MARKETING_EVENT_NAME_MAX)
    const date = e.date
    const createdAt = Number(e.createdAt)
    if (!name || !isValidDateKey(date) || !Number.isFinite(createdAt) || createdAt <= 0) continue
    out[id] = {
      name,
      date,
      createdAt,
      ...(Number.isFinite(Number(e.updatedAt)) && Number(e.updatedAt) > 0 ? { updatedAt: Number(e.updatedAt) } : {}),
      ...(typeof e.broadcastId === 'string' && e.broadcastId ? { broadcastId: e.broadcastId } : {}),
    }
  }
  return out
}

/** map → 依日期排好的清單（同一天先加的在前） */
export function eventList(map: MarketingEventMap): MarketingEvent[] {
  return Object.entries(map)
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** 拿掉過完很久的（`MARKETING_EVENT_KEEP_DAYS`）。寫入前呼叫。 */
export function pruneEventMap(map: MarketingEventMap, today: string): MarketingEventMap {
  const cutoff = addDays(today, -MARKETING_EVENT_KEEP_DAYS)
  return Object.fromEntries(Object.entries(map).filter(([, e]) => e.date >= cutoff))
}

export type EventInputResult =
  | { ok: true, name: string, date: string }
  | { ok: false, message: string }

/**
 * 驗「名稱＋日期」。前端送出前、後端寫入前都跑同一支（⛔ 兩邊各寫一份規則，遲早一邊放行一邊擋）。
 * 錯誤訊息直接給人看。
 */
export function validateEventInput(input: { name?: unknown, date?: unknown }, today: string): EventInputResult {
  const name = cleanEventName(input?.name)
  if (!name) return { ok: false, message: '請填檔期名稱' }
  if ([...name].length > MARKETING_EVENT_NAME_MAX) return { ok: false, message: `檔期名稱最多 ${MARKETING_EVENT_NAME_MAX} 個字` }
  const date = input?.date
  if (!isValidDateKey(date)) return { ok: false, message: '請選日期' }
  const inDays = daysBetween(today, date)
  if (inDays < 0) return { ok: false, message: '日期已經過了，只能加今天以後的檔期' }
  if (inDays > CALENDAR_WINDOW_DAYS) return { ok: false, message: `只能加 ${CALENDAR_WINDOW_DAYS} 天內的檔期（卡片只看未來 ${CALENDAR_WINDOW_DAYS} 天）` }
  return { ok: true, name, date }
}

/** 日期選單上哪幾天不能選（跟 `validateEventInput` 同一條規則） */
export function isEventDateDisabled(date: string, today: string): boolean {
  const inDays = daysBetween(today, date)
  return inDays < 0 || inDays > CALENDAR_WINDOW_DAYS
}

/**
 * 自己的檔期 → 跟節日表同一個形狀，月曆、提醒、回顧、擬文案都能直接吃。
 * ⛔ 沒有跨產業的切角：`angle` 給空字串，各處要吃得下（提醒那句改直接接「建議…」）。
 */
export function ownEventFestival(e: Pick<MarketingEvent, 'id' | 'name' | 'date'>): TaiwanFestival {
  return { id: e.id, date: e.date, name: e.name, angle: '', own: true }
}

/**
 * 加好之後那一句（toast）。
 * ⛔ 不寫「LINE 會提醒你」：早上的提醒要他綁了 LINE 通知、又沒關掉節日提醒才收得到，
 *   不是每個人都成立的承諾不要講。
 */
export function eventSavedText(name: string, isNew: boolean): string {
  return isNew ? `「${name}」加進來了。` : `「${name}」改好了。`
}

/** 刪除前問的那一句。⛔ 一定要講推播不會跟著刪：他會怕排好的那一則被一起刪掉 */
export function eventDeleteConfirmText(name: string): string {
  return `刪掉「${name}」這個檔期？已經建好的推播不會跟著刪。`
}
