/**
 * 「上一檔做得怎麼樣」——檔期成效回顧（`C-55`②，`C-240`；2026-10-11 `D-121` 改版）。
 *
 * ⚠️ 本案原本取號 `C-237`，與另一個 session 同日撞號，照慣例讓號改為 `C-240`。
 *   ⛔ commit `8cdd45c` 的訊息裡寫的還是 `C-237`，那是撞號前送出的，⛔ 不要據它反推編號。
 *
 * ── 這支在補的洞 ───────────────────────────────────────────────
 * 行銷月曆只講「接下來要做什麼」，做完之後**一句回顧都沒有**。沒有回顧的建議，
 * 第三個月就沒人看了。
 *
 * ── `D-121`（2026-10-11）拍板改掉的三件事 ─────────────────────────
 * ① **只算「為這一檔發的」推播**：從「為這一檔擬推播」建立的（帶 `festivalId`），
 *    或推播名稱裡有節日名的（「中秋禮盒早鳥」）。⛔ **不再照日期猜**——2026-10-11 正式資料：
 *    中秋 9/25 與國慶 10/10 只差 15 天，前後兩週的範圍重疊，同一批 6 則商品推播被兩檔各算一次；
 *    被算進節日的 14 則全是商品上市推播，跟節日無關。
 * ② **成效改看 LINE 官方統計的人數**（打開的人、點連結的人），由排程在發完後存進推播那一筆
 *    （`server/utils/broadcast-line-stats.ts`）。⛔ 不再用我們自己的點擊紀錄：它只數得出「次數」，
 *    而且**圖片上的連結從來沒記過**（`C-301`）——畫面因此寫過「連結一次都沒有被點」，
 *    LINE 那邊同一則記到 443 人點過。
 * ③ **人數不可以跨推播加總**：同一個人收到兩則就會被算兩次。一則一行，最多兩行。
 *
 * ── 照舊的三條 ─────────────────────────────────────────────────
 * - 沒為節日發推播的檔期要講出來，⛔ 不可以讓它從回顧裡消失。
 * - 建了但一個人都沒送出去的（排程失敗、受眾空掉）不算成效，但要講。
 * - 只發給 1～2 人的（試發、測試）不算成效，也要講「沒算進來」。
 */

import type { BroadcastLineStats } from './broadcast-line-stats'

/** LINE 官方統計（`D-121`②），定義在 `shared/broadcast-line-stats.ts` */
export type { BroadcastLineStats }

/** 一則已送出推播的成績。 */
export interface BroadcastOutcome {
  id: string
  name: string
  /** 送出完成的時間（毫秒）。⚠️ 來源是 `completedAt`——`sentAt` 這個欄位實際上不存在 */
  atMs: number
  sentCount: number
  /**
   * 這則推播**真的是為了哪一檔發的**。只有從「為這一檔擬推播」建立的才有（`C-240` 起）。
   */
  festivalId?: string
  /** 發完後存下來的 LINE 人數；沒有＝還沒存到（發完隔天才有）或發得太早、LINE 已經查不到 */
  line?: BroadcastLineStats | null
}

export interface FestivalOutcomeFestival {
  id: string
  name: string
  date: string
}

export interface FestivalOutcome {
  festivalId: string
  name: string
  date: string
  /** 算進這一檔的推播（為這一檔發的、而且不是試發），由近到遠 */
  broadcasts: BroadcastOutcome[]
  /** 建了但一個人都沒送出去的則數 */
  zeroSent: number
  /** 只發給 1～2 人（試發、測試）、沒算進來的則數 */
  testSends: number
}

/** 回顧裡的一行。`broadcast` 有值時，畫面把那則推播的名字做成連結。 */
export interface OutcomeLine {
  /** 名字前面那一段（例：「國慶日」） */
  before: string
  broadcast?: { id: string, name: string }
  /** 名字後面那一段 */
  after: string
}

/** 回顧往回看幾天。 */
export const OUTCOME_LOOKBACK_DAYS = 90
/** 最多回顧幾檔。⛔ 不要一次列六檔：回顧要短，不然沒人讀。 */
export const OUTCOME_MAX = 3
/** 同一檔最多列幾則推播，再多就講「另外 N 則」 */
export const OUTCOME_BROADCASTS_PER_FESTIVAL = 2
/** 送出人數小於等於這個數的當成試發 */
export const OUTCOME_TEST_SEND_MAX = 2
/** 名稱對上節日時，推播要落在節日前 30 天到後 7 天內（擋掉「去年的中秋禮盒」被算進今年） */
export const NAMED_WINDOW_BEFORE_DAYS = 30
export const NAMED_WINDOW_AFTER_DAYS = 7
/** LINE 用現在的查法只查得到大約一個月內的推播（2026-10-11 實測，8 月那幾則全回錯誤） */
export const LINE_STATS_QUERYABLE_DAYS = 28

const DAY = 86_400_000

function dateToMs(d: string): number {
  const [y, m, day] = String(d ?? '').split('-').map(Number)
  if (!y || !m || !day) return NaN
  return Date.UTC(y, m - 1, day)
}

/**
 * 推播名稱裡出現哪些字，就算是為這個節日發的。
 * ⚠️ 只收**一看就是這個節日**的字：「新年」「媽媽」這種會撞到別的檔、或平常也會用的字不收。
 */
const FESTIVAL_NAME_KEYWORDS: Record<string, string[]> = {
  '中元節': ['中元', '普渡'],
  '中秋節': ['中秋'],
  '國慶日': ['國慶', '雙十'],
  '重陽節': ['重陽'],
  '萬聖節': ['萬聖', 'halloween'],
  '雙 11 購物節': ['雙11', '雙十一', '1111'],
  '聖誕節': ['聖誕', 'xmas', 'christmas'],
  '元旦（跨年）': ['元旦', '跨年'],
  '除夕': ['除夕', '年夜飯'],
  '春節（農曆新年）': ['春節', '過年', '農曆新年'],
  '西洋情人節': ['情人節'],
  '元宵節': ['元宵'],
  '兒童節・清明節連假': ['兒童節', '清明'],
  '勞動節': ['勞動節', '五一'],
  '母親節': ['母親節'],
  '端午節': ['端午'],
  '父親節・七夕情人節': ['父親節', '七夕'],
}

/** 比對用：轉小寫、拿掉空白（「雙 11」與「雙11」要當成同一個） */
function normalizeForMatch(s: string): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, '')
}

/** 這個節日認得的名稱關鍵字。表裡沒有的節日退回「去掉尾巴的節／日」。 */
export function festivalNameKeywords(festivalName: string): string[] {
  const listed = FESTIVAL_NAME_KEYWORDS[festivalName]
  if (listed) return listed.map(normalizeForMatch)
  const base = normalizeForMatch(festivalName).replace(/（.*?）/g, '').replace(/[節日]$/, '')
  return base.length >= 2 ? [base] : []
}

/**
 * 這則推播是不是為了這一檔發的（`D-121`①）。
 * - `linked`：從「為這一檔擬推播」建立的（帶 `festivalId`）
 * - `named`：沒帶 `festivalId`，但名稱裡有節日名，而且落在節日前 30 天到後 7 天內
 * - `null`：都不是。⛔ 不再照「前後兩週」的日期猜
 */
export function broadcastFestivalMatch(
  b: { name: string, atMs: number | null, festivalId?: string },
  festival: FestivalOutcomeFestival,
): 'linked' | 'named' | null {
  if (b.festivalId) return b.festivalId === festival.id ? 'linked' : null
  const center = dateToMs(festival.date)
  if (Number.isNaN(center) || b.atMs == null || !Number.isFinite(b.atMs)) return null
  if (b.atMs < center - NAMED_WINDOW_BEFORE_DAYS * DAY || b.atMs > center + (NAMED_WINDOW_AFTER_DAYS + 1) * DAY) return null
  const name = normalizeForMatch(b.name)
  return festivalNameKeywords(festival.name).some(k => name.includes(k)) ? 'named' : null
}

/** 組出一檔的回顧。 */
export function buildOneOutcome(
  festival: FestivalOutcomeFestival,
  all: readonly BroadcastOutcome[],
): FestivalOutcome {
  const mine = all
    .filter(b => broadcastFestivalMatch(b, festival) !== null)
    .sort((a, b) => b.atMs - a.atMs)
  const zeroSent = mine.filter(b => b.sentCount <= 0).length
  const testSends = mine.filter(b => b.sentCount > 0 && b.sentCount <= OUTCOME_TEST_SEND_MAX).length
  return {
    festivalId: festival.id,
    name: festival.name,
    date: festival.date,
    broadcasts: mine.filter(b => b.sentCount > OUTCOME_TEST_SEND_MAX),
    zeroSent,
    testSends,
  }
}

/**
 * 組出最近幾檔的回顧（由近到遠，最多 `OUTCOME_MAX` 檔）。
 *
 * @param today `YYYY-MM-DD`
 * @param festivals 全部節日（呼叫端給 `TAIWAN_FESTIVALS`）
 */
export function buildFestivalOutcomes(
  today: string,
  festivals: readonly FestivalOutcomeFestival[],
  broadcasts: readonly BroadcastOutcome[],
  lookbackDays = OUTCOME_LOOKBACK_DAYS,
): FestivalOutcome[] {
  const now = dateToMs(today)
  if (Number.isNaN(now)) return []
  return festivals
    .filter((f) => {
      const ms = dateToMs(f.date)
      return !Number.isNaN(ms) && ms < now && now - ms <= lookbackDays * DAY
    })
    .sort((a, b) => dateToMs(b.date) - dateToMs(a.date))
    .slice(0, OUTCOME_MAX)
    .map(f => buildOneOutcome(f, broadcasts))
}

function n(x: number): string {
  return x.toLocaleString('en-US')
}

/**
 * 一則推播的成績那一段（名字後面接的字）。⛔ 拿不到的數字一律講原因，不寫 0。
 *
 * @param nowMs 用來判斷「還沒存到」與「發得太早、LINE 已經查不到」
 */
export function broadcastResultText(b: BroadcastOutcome, nowMs: number): string {
  const sent = `送 ${n(b.sentCount)} 人`
  const line = b.line
  if (!line) {
    const age = nowMs - b.atMs
    if (age <= 2 * DAY) return `${sent}，打開與點連結的人數發完隔天才有`
    if (age > LINE_STATS_QUERYABLE_DAYS * DAY) return `${sent}（發得比較早，LINE 已經查不到打開與點連結的人數）`
    return `${sent}，LINE 的打開與點連結人數還沒拿到`
  }
  if (line.unavailable) return `${sent}（這則發送時沒帶到 LINE 的統計標記，查不到打開與點連結的人數）`
  if (line.opened == null && line.clicked == null) return `${sent}，打開與點連結的人太少，LINE 不提供數字`
  const opened = line.opened == null ? '打開的人太少、LINE 不提供數字' : `${n(line.opened)} 人打開`
  const clicked = line.clicked == null ? '點連結的人太少、LINE 不提供數字' : `${n(line.clicked)} 人點連結`
  return `${sent}，${opened}，${clicked}（LINE 官方統計）`
}

/**
 * 回顧要畫的那幾行＋標題（`D-121`）。⛔ 一檔都沒有（回看窗內沒有過去的節日）就回空，整段不出現。
 *
 * - 有為節日發推播的檔：一則一行（最多 2 行），名字是連結。
 * - 沒發的檔：併成一行講「沒有為節日發的推播」。一檔都沒發時再補一句「從這裡擬的才看得到成效」——
 *   那句是他按「為這一檔擬推播」的理由；已經在用了就不必再講。
 */
export function outcomeSummary(outcomes: readonly FestivalOutcome[], nowMs: number): { label: string, lines: OutcomeLine[] } {
  if (!outcomes.length) return { label: '', lines: [] }
  const lines: OutcomeLine[] = []
  const without: string[] = []

  for (const o of outcomes) {
    const notes: string[] = []
    if (o.zeroSent) notes.push(`${o.zeroSent} 則建了但一個人都沒送出去，去推播頁看看卡在哪`)
    if (o.testSends) notes.push(`${o.testSends} 則只發給 1～2 人（試發），沒算進來`)

    if (!o.broadcasts.length) {
      if (notes.length) lines.push({ before: '', after: `${o.name}有 ${notes.join('；')}。` })
      else without.push(o.name)
      continue
    }
    const shown = o.broadcasts.slice(0, OUTCOME_BROADCASTS_PER_FESTIVAL)
    shown.forEach((b, i) => {
      const isLast = i === shown.length - 1
      const more = isLast && o.broadcasts.length > shown.length ? `。另外還有 ${o.broadcasts.length - shown.length} 則` : ''
      const tail = isLast && notes.length ? `。另有 ${notes.join('；')}` : ''
      lines.push({ before: o.name, broadcast: { id: b.id, name: b.name }, after: `${broadcastResultText(b, nowMs)}${more}${tail}` })
    })
  }

  if (without.length) {
    const anySent = outcomes.some(o => o.broadcasts.length > 0)
    const all = without.length === outcomes.length
    // 名單照時間由早到晚念（「中元節、中秋節、國慶日」）；上面的推播行則是最近的先講
    const names = [...without].reverse().join('、')
    lines.push({
      before: '',
      after: anySent
        ? `${names}沒有為節日發的推播。`
        : `${names}${all && without.length > 1 ? '都' : ''}沒有為節日發的推播。從這裡擬的推播，發完會在這裡看到幾個人打開、幾個人點。`,
    })
  }

  // ⛔ 標題不寫「上一檔」再列三檔——同一行自己打架
  return { label: outcomes.length === 1 ? '上一檔' : `最近 ${outcomes.length} 檔`, lines }
}

/** 把一行接成純文字（測試與守門員用）。 */
export function outcomeLineText(l: OutcomeLine): string {
  return `${l.before}${l.broadcast ? `「${l.broadcast.name}」` : ''}${l.after}`
}

/**
 * 去年同一個節日，為它發過的推播（當「為什麼是你」的證據，`D-121`①同一條歸屬規則）。
 * ⛔ 不再照日期猜：去年這時候發的商品推播不是「去年這一檔」。
 * 一檔有好幾則時取送最多人的那一則；試發不算。
 */
export function findLastYearFestivalBroadcast(
  festival: { name: string, date: string },
  festivals: readonly FestivalOutcomeFestival[],
  broadcasts: readonly BroadcastOutcome[],
): BroadcastOutcome | null {
  const year = Number(festival.date.slice(0, 4))
  if (!year) return null
  const lastYear = festivals.find(f => f.name === festival.name && Number(f.date.slice(0, 4)) === year - 1)
  if (!lastYear) return null
  const hits = buildOneOutcome(lastYear, broadcasts).broadcasts
  if (!hits.length) return null
  return [...hits].sort((a, b) => b.sentCount - a.sentCount)[0]!
}
