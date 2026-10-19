/**
 * 90 天行銷月曆與每檔的建議卡（`D-85` / `C-224`）。
 *
 * ── 這一頁要回答什麼 ───────────────────────────────────────────
 * 「接下來三個月有哪些檔期、每一檔我該做什麼」。
 * `C-223` 已經讓**節日前 7 天那則 LINE** 講得出你的商品，但那是**推播式**的：
 * 時間到了才講、講完就過去了。商家想「這一季怎麼排」的時候沒有地方看。
 *
 * ── 四條紀律 ───────────────────────────────────────────────────
 * ① **每一句「為什麼」都要有出處**。拿不到數字就**不出那一段**，
 *    ⛔ 不可以寫「這個檔期通常表現不錯」這種沒有根據的話（`D-85` 第六條紀律）。
 * ② **「還沒有你的數字」要講出來**，不要假裝這是為他算的。
 * ③ **不要承諾成效**：不可以出現「可以多賣三成」這種我們算不出來的話。
 * ④ **純函式**：這裡不打 LLM、不查資料庫，數字由呼叫端餵進來。
 *    文案要能被測試釘住——這是商家每天會看到的東西。
 */

import { broadcastFestivalMatch } from './festival-outcome'
import { TAIWAN_FESTIVALS, type TaiwanFestival } from './taiwan-festivals'
import { daysBetween, taipeiDateTime } from './time'
import {
  storeProfileFieldDef,
  type StoreProfileDoc,
} from './types/store-profile'

/** 月曆看多遠。90 天＝一季，再遠商家不會現在決定。 */
export const CALENDAR_WINDOW_DAYS = 90
/** 幾天內算「快到了」（畫面上要跳出來） */
export const CALENDAR_SOON_DAYS = 14

/** 建議卡要用到的、這家店的真實數字。⛔ 拿不到的一律 `null`，不要用 0 代替。 */
export interface CalendarFacts {
  /** 好友總數 */
  friendCount: number | null
  /**
   * 跟這個檔期對得上的標籤：{ 標籤名, 人數, 憑什麼算對得上 }。
   *
   * ⚠️ `why` 是 `C-235` 加的，由 `shared/festival-audience.ts` 算。**非加不可**：
   *   「你有 206 位客人貼著『問卷 - AROMIC睡眠香氛機』」這句話，少了 why 會被讀成
   *   「206 個人想買香氛機」，但那只是填過問卷的名冊（`D-28` 那條鐵律）。
   */
  matchedTags: { name: string, memberCount: number, why?: string }[]
  /**
   * 去年同一檔**為它發過**的推播（`D-121`：歸屬規則跟回顧同一條，⛔ 不再照日期猜）。
   * `clicked`＝LINE 官方統計的點連結人數，拿不到是 null。查不到這則推播＝null
   */
  lastYearBroadcast: { name: string, sentCount: number, clicked?: number | null } | null
}

/**
 * 已經為這一檔建好的推播（`D-121`：已排程的那一檔直接講排在哪天，不會再擬一次）。
 * `atMs`：排程的就是排程時間、發完的就是發完時間、草稿是 null。
 */
export interface PlannedBroadcast {
  id: string
  name: string
  status: 'draft' | 'scheduled' | 'processing' | 'completed' | 'failed'
  atMs: number | null
}

const PLANNED_ORDER: Record<PlannedBroadcast['status'], number> = {
  scheduled: 0,
  processing: 1,
  completed: 2,
  draft: 3,
  failed: 4,
}

/** 好幾則時挑最該講的那一則：排好的 → 發送中 → 發完的 → 草稿 → 失敗的。 */
export function pickPlanned(list: readonly PlannedBroadcast[]): PlannedBroadcast | null {
  if (!list.length) return null
  return [...list].sort((a, b) =>
    PLANNED_ORDER[a.status] - PLANNED_ORDER[b.status] || (a.atMs ?? Infinity) - (b.atMs ?? Infinity))[0]!
}

/** 掃推播時每一則留下的東西（`server/utils/marketing-calendar-broadcasts.ts` 組出來） */
export interface CalendarBroadcastRow extends PlannedBroadcast {
  /** 從「為這一檔擬推播」建的、或「設成檔期」的：那一檔的 id */
  festivalId?: string
  /** 名稱對檔期時拿來比日期的時間：排程的看排程時間、發完的看發完時間、草稿看建立時間 */
  matchAtMs: number | null
}

/**
 * 已經為這一檔建好的推播（`D-121`；`D-122` 起卡片與早上的 LINE 提醒**共用這一支**）。
 * ⛔ 不要在別處再寫一份判斷：卡片說「已排程」、LINE 卻叫他「今天就去排」，正是 `D-122`① 要修的事。
 */
export function plannedForFestival(
  rows: readonly CalendarBroadcastRow[],
  f: { id: string, name: string, date: string, own?: boolean },
): PlannedBroadcast[] {
  return rows
    .filter(p => broadcastFestivalMatch({ name: p.name, atMs: p.matchAtMs, festivalId: p.festivalId }, f) !== null)
    .map(({ id, name, status, atMs }) => ({ id, name, status, atMs }))
}

/** 那則推播現在的狀態，一小段話（「已排程 11/09 20:00」）。時間一律台灣時間。 */
export function plannedStatusText(p: PlannedBroadcast): string {
  const md = (ms: number) => taipeiDateTime(ms).slice(5, 10).replace('-', '/')
  const mdhm = (ms: number) => taipeiDateTime(ms).slice(5).replace('-', '/')
  switch (p.status) {
    case 'scheduled': return p.atMs != null ? `已排程 ${mdhm(p.atMs)}` : '已排程'
    case 'processing': return '發送中'
    case 'completed': return p.atMs != null ? `已發送 ${md(p.atMs)}` : '已發送'
    case 'failed': return '發送失敗'
    default: return '草稿，還沒排程'
  }
}

export function emptyCalendarFacts(): CalendarFacts {
  return { friendCount: null, matchedTags: [], lastYearBroadcast: null }
}

export interface CalendarEntry {
  festivalId: string
  date: string
  name: string
  /** 距今幾天 */
  inDays: number
  /** 快到了（≤ 14 天） */
  soon: boolean
  /** 跨產業通用的一句（`taiwan-festivals` 的 angle）——永遠有 */
  generalAngle: string
  /**
   * 「為什麼是你」：**每一條都帶出處**。空陣列＝這一檔還沒有你的數字，
   * ⛔ 畫面上要講出來，不可以假裝這是為他算的。
   */
  reasons: { text: string, source: string }[]
  /**
   * 「做什麼」：**只留跟時間有關的**（`D-121`③）——3 天內的「最後確認」、兩週內連假的「客服值班」。
   * 常常是空陣列，畫面就不出那一段。
   */
  actions: string[]
  /** 已經為這一檔建好的推播（`D-121`）。空陣列＝還沒有 */
  planned: PlannedBroadcast[]
  /**
   * 店家自己加的檔期（`D-122`②）。卡片上標「自己的」、給「修改／刪除」而不是「這次不做」；
   * `generalAngle` 是空字串（沒有跨產業的切角）。
   */
  own?: boolean
}

/** 這家店的旺季答案跟這個節日對不對得上。 */
export function seasonMatchesFestival(profile: StoreProfileDoc | null | undefined, f: TaiwanFestival): boolean {
  const season = String(profile?.fields?.season?.value ?? '')
  if (!season) return false
  if (/送禮|春節|中秋/.test(season) && /春節|中秋|除夕|元宵|端午|聖誕|情人/.test(f.name)) return true
  if (/夏天/.test(season) && /端午|父親節|七夕|中元/.test(f.name)) return true
  if (/冬天/.test(season) && /聖誕|跨年|元旦|春節|除夕/.test(f.name)) return true
  if (/開學|收假/.test(season) && /兒童節|開學/.test(f.name)) return true
  return false
}

/**
 * 組出一檔的「為什麼」。⛔ **每一條都要有出處**，湊不出來就回空陣列——
 * 空陣列不是失敗，是誠實（畫面會說「這一檔還沒有你的數字」）。
 */
export function buildReasons(
  profile: StoreProfileDoc | null | undefined,
  f: TaiwanFestival,
  facts: CalendarFacts,
): { text: string, source: string }[] {
  const out: { text: string, source: string }[] = []

  if (seasonMatchesFestival(profile, f)) {
    const season = profile!.fields!.season!.value
    out.push({
      text: `這正好落在你說的旺季裡（${season}）`,
      source: `你在「${storeProfileFieldDef('season')?.label ?? '旺季'}」填的答案`,
    })
  }

  for (const t of facts.matchedTags.slice(0, 2)) {
    if (t.memberCount <= 0) continue
    out.push({
      // ⛔ `why` 有就一定要講出來：沒有它，事件型標籤（問卷名冊）會被讀成「這些人想買」
      text: `你有 ${t.memberCount} 位客人貼著「${t.name}」${t.why ? `——${t.why}` : ''}，這一檔可以直接發給他們`,
      source: '標籤管理的實際人數',
    })
  }

  const ly = facts.lastYearBroadcast
  if (ly && ly.sentCount > 0) {
    const clicked = ly.clicked != null ? `，${ly.clicked.toLocaleString('en-US')} 人點連結` : ''
    out.push({
      text: `去年這一檔你發過「${ly.name}」，送到 ${ly.sentCount.toLocaleString('en-US')} 人${clicked}`,
      source: ly.clicked != null ? '推播紀錄＋LINE 官方統計' : '推播紀錄',
    })
  }

  // ⛔ 只有好友總數時**不要單獨當理由**：「你有 300 位好友」對每一個節日都成立，
  //    等於沒講。它只在上面至少有一條時才補上來當規模參考。
  if (out.length && facts.friendCount != null && facts.friendCount > 0) {
    out.push({ text: `目前好友 ${facts.friendCount} 位`, source: '好友頁' })
  }
  return out
}

/**
 * 組出一檔的「做什麼」。⛔ 不承諾成效。
 *
 * `D-121`③（2026-10-11 拍板）：**只留跟時間有關的那一句**。原本固定三件事，量出來五檔裡
 * 「想好出貨時間」「當天顧客服」每檔都一樣，第一件「把文案與圖片準備好」又跟
 * 「為這一檔擬推播」那顆按鈕是同一件事——五檔重複五次＝沒人讀。
 * 節日前 7／3／1 天的 LINE 提醒（`C-223`）本來就會講該做什麼。
 */
export function buildActions(profile: StoreProfileDoc | null | undefined, f: TaiwanFestival, inDays: number): string[] {
  const channel = String(profile?.fields?.channel?.value ?? '')
  const out: string[] = []
  if (inDays <= 3) {
    out.push(channel.includes('預約')
      ? '最後確認推播排了沒、這幾天的時段開好了沒'
      : '最後確認推播排了沒、庫存和出貨來不來得及')
  }
  if (f.longWeekend && inDays <= CALENDAR_SOON_DAYS) out.push('連假期間客服值班先排好')
  return out
}

/**
 * 產出未來 N 天的月曆。`facts` 給每個節日各一份（呼叫端算好）。
 *
 * @param ownEvents 店家自己的檔期（`D-122`②，`ownEventFestival` 轉好的）。跟節日排在一起，
 *   ⛔ 待遇一樣：快到時攤開、可以擬推播、講得出已經排了哪一則。同一天的話自己的排前面
 *   （跟早上的 LINE 提醒同一個先後，`pickFestivalReminder`）。
 */
export function buildMarketingCalendar(
  today: string,
  profile: StoreProfileDoc | null | undefined,
  factsOf: (f: TaiwanFestival) => CalendarFacts,
  windowDays = CALENDAR_WINDOW_DAYS,
  plannedOf: (f: TaiwanFestival) => PlannedBroadcast[] = () => [],
  ownEvents: readonly TaiwanFestival[] = [],
): CalendarEntry[] {
  const out: CalendarEntry[] = []
  const all = [...TAIWAN_FESTIVALS, ...ownEvents]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.date.localeCompare(b.f.date) || Number(Boolean(b.f.own)) - Number(Boolean(a.f.own)) || a.i - b.i)
  for (const { f } of all) {
    const inDays = daysBetween(today, f.date)
    if (inDays < 0 || inDays > windowDays) continue
    const facts = factsOf(f)
    out.push({
      festivalId: f.id,
      date: f.date,
      name: f.name,
      inDays,
      soon: inDays <= CALENDAR_SOON_DAYS,
      generalAngle: f.angle,
      reasons: buildReasons(profile, f, facts),
      actions: buildActions(profile, f, inDays),
      planned: plannedOf(f),
      ...(f.own ? { own: true } : {}),
    })
  }
  return out
}

/**
 * 卡片標題旁那一小段。
 *
 * `D-121`：原本這裡寫「未來 90 天有 5 個檔期，其中 1 個兩週內就到。MiniMe 還不認識你的店，所以下面只有通用的建議。」
 * ——檔期數就是下面那幾列、快到的那一檔本來就攤開；「還不認識你的店」卡片裡的提示列也講了。
 * 同一句在標題列、藍框、每一檔各講一次（「通用」出現 7 次）。⛔ 這裡只講範圍，提示一律交給卡片裡那一列。
 */
export function calendarHeadline(): string {
  return `未來 ${CALENDAR_WINDOW_DAYS} 天`
}

/** 這一檔有沒有「為什麼是你」。畫面用它決定要不要顯示那一段。 */
export function hasOwnReasons(entry: CalendarEntry): boolean {
  return entry.reasons.length > 0
}
