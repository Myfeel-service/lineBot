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

import { TAIWAN_FESTIVALS, type TaiwanFestival } from './taiwan-festivals'
import { daysBetween } from './time'
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
   * 跟這個檔期對得上的標籤：{ 標籤名, 人數 }。
   * 例：旺季是送禮的店，「送禮客」那顆標籤有幾個人。
   */
  matchedTags: { name: string, memberCount: number }[]
  /** 去年同一個節日前後有沒有發過推播（發給幾人）。查不到＝null */
  lastYearBroadcast: { name: string, sentCount: number } | null
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
  /** 「做什麼」：三件具體的事 */
  actions: string[]
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
      text: `你有 ${t.memberCount} 位客人貼著「${t.name}」，這一檔可以直接發給他們`,
      source: '標籤管理的實際人數',
    })
  }

  if (facts.lastYearBroadcast && facts.lastYearBroadcast.sentCount > 0) {
    out.push({
      text: `去年這個時候你發過「${facts.lastYearBroadcast.name}」，送到 ${facts.lastYearBroadcast.sentCount} 人`,
      source: '推播紀錄',
    })
  }

  // ⛔ 只有好友總數時**不要單獨當理由**：「你有 300 位好友」對每一個節日都成立，
  //    等於沒講。它只在上面至少有一條時才補上來當規模參考。
  if (out.length && facts.friendCount != null && facts.friendCount > 0) {
    out.push({ text: `目前好友 ${facts.friendCount} 位`, source: '好友頁' })
  }
  return out
}

/** 組出一檔的「做什麼」三件事。⛔ 不承諾成效。 */
export function buildActions(profile: StoreProfileDoc | null | undefined, f: TaiwanFestival, inDays: number): string[] {
  const channel = String(profile?.fields?.channel?.value ?? '')
  const out: string[] = []

  if (inDays > 14) out.push('先決定這一檔要推什麼、用什麼理由')
  else if (inDays > 3) out.push('把推播文案與圖片準備好，排進排程')
  else out.push('最後確認推播排了沒、庫存和出貨來不來得及')

  out.push(channel.includes('預約')
    ? '想好這一檔的時段怎麼開，別讓客人約不到'
    : '想好這一檔的出貨時間，寫進訊息裡')

  out.push(f.longWeekend ? '連假期間客服值班先排好' : '當天安排人顧線上客服')
  return out
}

/** 產出未來 N 天的月曆。`facts` 給每個節日各一份（呼叫端算好）。 */
export function buildMarketingCalendar(
  today: string,
  profile: StoreProfileDoc | null | undefined,
  factsOf: (f: TaiwanFestival) => CalendarFacts,
  windowDays = CALENDAR_WINDOW_DAYS,
): CalendarEntry[] {
  const out: CalendarEntry[] = []
  for (const f of TAIWAN_FESTIVALS) {
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
    })
  }
  return out
}

/** 月曆最上面那一句。⛔ 沒有輪廓時要講出來，不要假裝這是為他算的。 */
export function calendarHeadline(entries: CalendarEntry[], hasProfile: boolean): string {
  if (!entries.length) return `未來 ${CALENDAR_WINDOW_DAYS} 天沒有重要節日，可以專心顧日常。`
  const soon = entries.filter(e => e.soon).length
  const base = `未來 ${CALENDAR_WINDOW_DAYS} 天有 ${entries.length} 個檔期${soon ? `，其中 ${soon} 個兩週內就到` : ''}。`
  // ⛔ 沒有輪廓＝下面那幾張卡只有通用切角，這件事一定要講
  return hasProfile ? base : `${base}MiniMe 還不認識你的店，所以下面只有通用的建議。`
}

/** 這一檔有沒有「為什麼是你」。畫面用它決定要不要顯示那一段。 */
export function hasOwnReasons(entry: CalendarEntry): boolean {
  return entry.reasons.length > 0
}
