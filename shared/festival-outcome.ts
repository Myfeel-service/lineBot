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

import { LINE_STATS_MAX_AGE_DAYS, type BroadcastLineStats } from './broadcast-line-stats'

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
/**
 * LINE 用現在的查法只查得到大約一個月內的推播（2026-10-11 實測，8 月那幾則全回錯誤）。
 * ⛔ 跟排程、成效頁用同一個數字（`shared/broadcast-line-stats.ts`），不要各寫一份。
 */
export const LINE_STATS_QUERYABLE_DAYS = LINE_STATS_MAX_AGE_DAYS

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

/**
 * 名稱裡出現這些字時，**那一段不算這個節日**（2026-10-12 審查）。
 *
 * 別檔的字剛好包著這一檔的字時（「雙十一」包著國慶日的「雙十」）由 `festivalBlockers` 自動算出來，
 * 這裡只補**不在節日表上**、但會包住表上字的日子：
 * - 「雙十二」：雙 12 刻意不收（`taiwan-festivals.ts`），它的「雙十」一樣不是國慶。
 * - 「白色情人節」（3/14）、「七夕情人節」：只寫「情人節」才是西洋情人節。白色情人節的預購常在
 *   2 月中就排草稿，不擋的話會被當成「情人節已經排好了」，把「為這一檔擬推播」藏起來。
 */
const NOT_THIS_FESTIVAL: Record<string, string[]> = {
  '國慶日': ['雙十二'],
  '西洋情人節': ['白色情人節', '七夕情人節'],
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

const blockerCache = new Map<string, string[]>()

/**
 * 會包住這一檔關鍵字、但講的是別的日子的長字（長的先拿掉）。
 * ⭐ 別檔的字是**從關鍵字表自動算的**：以後新增關鍵字撞到既有的字，不必記得回來補這張表
 *   （`festival-outcome.test.ts`「全表盤點」那條會把新的一對驗進來）。
 */
function festivalBlockers(festivalName: string): string[] {
  const cached = blockerCache.get(festivalName)
  if (cached) return cached
  const own = festivalNameKeywords(festivalName)
  const fromOtherFestivals = Object.keys(FESTIVAL_NAME_KEYWORDS)
    .filter(other => other !== festivalName)
    .flatMap(other => festivalNameKeywords(other))
    .filter(k => !own.includes(k) && own.some(o => k.includes(o)))
  const out = [...new Set([...fromOtherFestivals, ...(NOT_THIS_FESTIVAL[festivalName] ?? []).map(normalizeForMatch)])]
    .sort((a, b) => b.length - a.length)
  blockerCache.set(festivalName, out)
  return out
}

/** 推播名稱裡有沒有這個節日的字（先把「包著它、但講別的日子」的長字拿掉再比）。 */
function nameMatchesFestival(broadcastName: string, festivalName: string): boolean {
  let name = normalizeForMatch(broadcastName)
  // 換成名稱裡不會出現的字元：直接刪掉的話，前後兩段接起來可能拼出新的關鍵字
  for (const longer of festivalBlockers(festivalName)) name = name.split(longer).join('\u0000')
  return festivalNameKeywords(festivalName).some(k => name.includes(k))
}

/** 歸屬規則本體：給一段日期範圍（毫秒，頭尾都算），名稱與 `festivalId` 的規則跟 `broadcastFestivalMatch` 同一條。 */
function matchInRange(
  b: { name: string, atMs: number | null, festivalId?: string },
  festivalId: string | undefined,
  festivalName: string,
  fromMs: number,
  toMs: number,
): 'linked' | 'named' | null {
  if (b.festivalId) return festivalId && b.festivalId === festivalId ? 'linked' : null
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || b.atMs == null || !Number.isFinite(b.atMs)) return null
  if (b.atMs < fromMs || b.atMs > toMs) return null
  return nameMatchesFestival(b.name, festivalName) ? 'named' : null
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
  const center = dateToMs(festival.date)
  return matchInRange(b, festival.id, festival.name, center - NAMED_WINDOW_BEFORE_DAYS * DAY, center + (NAMED_WINDOW_AFTER_DAYS + 1) * DAY)
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
 * 節日表上**沒有去年那一檔**時，去年的日期最多可能跟「去年同月同日」差幾天。
 *
 * 2026-10-12 審查抓到：節日表從 2026-08-27 才開始，只認表上的「去年那一檔」的話，
 * 2027 年中以前的每一檔都找不到去年，「去年這一檔你發過…」一次都不會出現。
 * 所以表上沒有時，改看「去年同月同日」前後——但農曆節日每年的國曆日期都不一樣：
 * - 農曆一年 353～355 天（有閏月 383～385 天），國曆一年 365／366 天，
 *   所以去年的農曆節日會比「去年同月同日」**晚 10～13 天或早 17～20 天**
 *   （例：2026 春節 2/17，2025 春節 1/29，早了 19 天）→ 前後各放寬 20 天。
 * - 母親節＝五月第二個週日，每年在 5/8～5/14 之間移動 → 放寬 7 天。
 * - 清明 4/4 或 4/5，連假的頭尾也會跟著移 → 放寬 2 天。
 * - 其他國曆節日（元旦、國慶、聖誕…）日期固定，不放寬。
 *
 * ⛔ 只放寬**日期**，歸屬規則不變：名稱要有節日的字、試發不算、綁在別檔的不算。
 *   放寬後的範圍最多 50＋28 天，離今年與前年都還有大半年，不會撿到別年的。
 * ⛔ 選「日期放寬＋名稱比對」而不是「照日期猜」：商品推播照樣不會被當成去年這一檔（`D-121`①）。
 */
const LAST_YEAR_DATE_DRIFT_DAYS: Record<string, number> = {
  '除夕': 20,
  '春節（農曆新年）': 20,
  '元宵節': 20,
  '端午節': 20,
  // 2027 年父親節（國曆 8/8）與七夕（農曆）同一天才合成一條；去年的七夕不在 8/8，照農曆放寬
  '父親節・七夕情人節': 20,
  '中元節': 20,
  '中秋節': 20,
  '重陽節': 20,
  '母親節': 7,
  '兒童節・清明節連假': 2,
}

/**
 * 去年同一個節日，為它發過的推播（當「為什麼是你」的證據，`D-121`①同一條歸屬規則）。
 * ⛔ 不再照日期猜：去年這時候發的商品推播不是「去年這一檔」。
 * 一檔有好幾則時取送最多人的那一則；試發不算。
 *
 * 節日表上有去年那一檔就照它的日期；沒有（表從 2026-08-27 才開始）就看「去年同月同日」前後，
 * 農曆節日放寬範圍（`LAST_YEAR_DATE_DRIFT_DAYS`）。
 */
export function findLastYearFestivalBroadcast(
  festival: { id?: string, name: string, date: string },
  festivals: readonly FestivalOutcomeFestival[],
  broadcasts: readonly BroadcastOutcome[],
): BroadcastOutcome | null {
  const [year, month, day] = String(festival.date ?? '').split('-').map(Number)
  if (!year || !month || !day) return null

  const pickBest = (hits: readonly BroadcastOutcome[]) =>
    hits.length ? [...hits].sort((a, b) => b.sentCount - a.sentCount)[0]! : null

  const lastYear = festivals.find(f => f.name === festival.name && Number(f.date.slice(0, 4)) === year - 1)
  if (lastYear) return pickBest(buildOneOutcome(lastYear, broadcasts).broadcasts)

  // 表上沒有去年那一檔：從今年的 id 推出去年的（`{slug}-{西元年}`），從這裡擬的推播才認得
  const lastYearId = festival.id && /-\d{4}$/.test(festival.id)
    ? festival.id.replace(/-\d{4}$/, `-${year - 1}`)
    : undefined
  const center = Date.UTC(year - 1, month - 1, day)
  const drift = LAST_YEAR_DATE_DRIFT_DAYS[festival.name] ?? 0
  const from = center - (NAMED_WINDOW_BEFORE_DAYS + drift) * DAY
  const to = center + (NAMED_WINDOW_AFTER_DAYS + 1 + drift) * DAY
  return pickBest(broadcasts.filter(b =>
    b.sentCount > OUTCOME_TEST_SEND_MAX
    && matchInRange(b, lastYearId, festival.name, from, to) !== null))
}
