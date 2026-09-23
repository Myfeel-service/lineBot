/**
 * 「上一檔做得怎麼樣」——檔期成效回顧（`C-55`②，`C-237`）。
 *
 * ── 這支在補的洞 ───────────────────────────────────────────────
 * 行銷月曆只講「接下來要做什麼」，做完之後**一句回顧都沒有**。沒有回顧的建議，
 * 第三個月就沒人看了——而且 `C-55`③「下次建議吸取上次結果」沒有這一層就無從談起。
 *
 * ── 一條口徑紅線（寫錯就會騙人）─────────────────────────────────
 * ⛔ **點擊是「幾次」不是「幾個人」。**
 *   推播走 multicast，同一則訊息發給所有人，追蹤連結的 token 裡
 *   （`broadcast-click-track.ts` 的 `[campaignId, '', '', linkKey, url]`）**沒有 userId**，
 *   所以 `broadcastClickLogs` 每一筆的 `userId` 都是 `null`。
 *   「846 人收到、184 次點擊」⛔ **不等於** 184 個人點了——可能是 60 個人各點三下。
 *   所以這裡的指標叫「**每 100 人收到，被點 N 次**」，⛔ 不准叫「點擊率」「CTR」「幾成的人點了」。
 *
 * ── 另外三條 ───────────────────────────────────────────────────
 * ① **沒發推播的檔期要出現、要講「你沒發」**，⛔ 不可以讓它從回顧裡消失
 *    ——那會讓人以為那一檔沒發生過。
 * ② **比較只在兩檔都有送出資料時才講**。單邊有資料的「成長 100%」是假的。
 * ③ **送出 0 人的不算一檔**（排程失敗、受眾空掉那種），但也不能靜靜吃掉，要講。
 */

/** 一則推播的成績。`clickCount`＝追蹤連結被點**幾次**（⛔ 不是幾個人）。 */
export interface BroadcastOutcome {
  id: string
  name: string
  /** 送出完成的時間（毫秒）。⚠️ 來源是 `completedAt`——`sentAt` 這個欄位實際上不存在 */
  atMs: number
  sentCount: number
  clickCount: number
  /**
   * 這則推播**真的是為了哪一檔發的**。
   *
   * ⭐ 只有從「為這一檔擬推播」建立的才有（`C-237` 起）。
   * ⚠️ **這一欄就是「知道」與「猜」的分界線**：2026-09-23 拿正式資料跑，照日期窗抓的話
   *   中元節會被算進 8 則推播、3,025 人——但那 8 則全是乾淨方MAX／AROMIC／KIESLECT
   *   的商品檔期，跟中元節一點關係都沒有，只是剛好落在前後兩週內。
   *   ⛔ 把那個數字講成「你的中元節成績」就是捏造。
   */
  festivalId?: string
}

export interface FestivalOutcome {
  festivalId: string
  name: string
  date: string
  /** 這一檔前後窗內送出的推播 */
  broadcasts: BroadcastOutcome[]
  sentTotal: number
  clickTotal: number
  /**
   * 每 100 人收到，被點幾次。沒送出過就是 `null`。
   * ⛔ **不要把它讀成「幾 % 的人點了」**——分子是次數、分母是人數，兩者單位不同。
   */
  clicksPer100: number | null
  /** 給人看的一句。沒發推播時講的是「你沒發」，不是空白 */
  text: string
  /**
   * 這幾則是**真的綁在這一檔上**（`true`），還是只是**那段期間發的**（`false`）。
   * ⛔ 畫面與文字都要分得出來——`false` 的時候不可以講成「這一檔的成績」。
   */
  linked: boolean
}

/** 檔期前後幾天內送出的推播，算進這一檔。 */
export const OUTCOME_WINDOW_DAYS = 14
/** 回顧往回看幾天。 */
export const OUTCOME_LOOKBACK_DAYS = 90
/** 最多回顧幾檔。⛔ 不要一次列六檔：回顧要短，不然沒人讀。 */
export const OUTCOME_MAX = 3

const DAY = 86_400_000

function dateToMs(d: string): number {
  const [y, m, day] = String(d ?? '').split('-').map(Number)
  if (!y || !m || !day) return NaN
  return Date.UTC(y, m - 1, day)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** 把一則推播歸給哪一檔（前後 `OUTCOME_WINDOW_DAYS` 天內）。 */
export function broadcastBelongsTo(b: BroadcastOutcome, festivalDate: string): boolean {
  const center = dateToMs(festivalDate)
  if (Number.isNaN(center) || !Number.isFinite(b.atMs)) return false
  return Math.abs(b.atMs - center) <= OUTCOME_WINDOW_DAYS * DAY
}

/**
 * 組出一檔的回顧。
 *
 * @param prev 上一檔（時間上更早的那一檔）的結果，用來比較。⛔ 沒有就傳 `null`，不要自己編。
 */
export function buildOneOutcome(
  festival: { id: string, name: string, date: string },
  all: readonly BroadcastOutcome[],
  prev: FestivalOutcome | null,
): FestivalOutcome {
  /**
   * ⭐ **先看有沒有真的綁在這一檔上的**；有的話就只算那些，其餘一律不碰。
   *   沒有才退回「那段期間發的」，而且文字要講清楚那是用日期猜的。
   */
  const linkedAll = all.filter(b => b.festivalId && b.festivalId === festival.id)
  const linked = linkedAll.length > 0
  const inWindow = linked ? linkedAll : all.filter(b => !b.festivalId && broadcastBelongsTo(b, festival.date))

  // ⛔ 送出 0 人的不算一檔，但下面要講出來（鐵律③）
  const counted = inWindow.filter(b => b.sentCount > 0)
  const zeroSent = inWindow.length - counted.length

  const sentTotal = counted.reduce((s, b) => s + b.sentCount, 0)
  const clickTotal = counted.reduce((s, b) => s + b.clickCount, 0)
  const clicksPer100 = sentTotal > 0 ? round1((clickTotal / sentTotal) * 100) : null

  return {
    festivalId: festival.id,
    name: festival.name,
    date: festival.date,
    broadcasts: counted,
    sentTotal,
    clickTotal,
    clicksPer100,
    linked,
    text: outcomeText({ festival, counted, zeroSent, sentTotal, clickTotal, clicksPer100, prev, linked }),
  }
}

function outcomeText(o: {
  festival: { name: string }
  counted: readonly BroadcastOutcome[]
  zeroSent: number
  sentTotal: number
  clickTotal: number
  clicksPer100: number | null
  prev: FestivalOutcome | null
  linked: boolean
}): string {
  // 鐵律①：沒發要講「你沒發」，⛔ 不可以消失
  if (!o.counted.length) {
    const tail = o.zeroSent > 0
      ? `（有 ${o.zeroSent} 則建了但一個人都沒送出去，去推播頁看看卡在哪）`
      : ''
    return `「${o.festival.name}」你沒有發推播${tail}。`
  }

  const what = o.counted.length === 1
    ? `發了「${o.counted[0]!.name}」`
    : `發了 ${o.counted.length} 則推播`
  // ⛔ 口徑紅線：次數不是人數
  const perf = o.clickTotal > 0
    ? `送到 ${o.sentTotal} 人，連結被點了 ${o.clickTotal} 次（每 100 人收到被點 ${o.clicksPer100} 次）`
    : `送到 ${o.sentTotal} 人，連結一次都沒有被點——⚠️ 如果那則推播裡本來就沒有放連結，這個數字看不出成效`

  /**
   * ⛔ **鐵律②：兩邊都要是「真的綁在那一檔上」才比**。
   * 拿兩批只是時間相近的商品檔期去比「哪一檔做得好」，比出來的是雜訊。
   */
  let cmp = ''
  if (o.linked && o.prev?.linked && o.prev.clicksPer100 != null && o.clicksPer100 != null) {
    const d = round1(o.clicksPer100 - o.prev.clicksPer100)
    if (d > 0) cmp = `　比「${o.prev.name}」那一檔多 ${d} 次／百人。`
    else if (d < 0) cmp = `　比「${o.prev.name}」那一檔少 ${Math.abs(d)} 次／百人。`
    else cmp = `　跟「${o.prev.name}」那一檔一樣。`
  }

  const zero = o.zeroSent > 0 ? `　另有 ${o.zeroSent} 則建了沒送出去。` : ''

  if (o.linked) return `「${o.festival.name}」${what}，${perf}。${cmp}${zero}`

  /**
   * ⛔ **沒有綁定時，話要講成「那段期間」不是「這一檔」**。
   * ⚠️ 2026-09-23 實測：中元節前後兩週抓到 8 則、3,025 人，但那 8 則全是商品檔期推播。
   *   講成「你的中元節成績」就是編一個不存在的檔期出來。
   */
  return `「${o.festival.name}」前後兩週你${what}，${perf}。${zero}`
    + '⚠️ 這幾則不一定是為了這一檔發的——是照日期抓的。以後用「為這一檔擬推播」建立的，才對得起來。'
}

/**
 * 組出最近幾檔的回顧（由近到遠）。
 *
 * @param today `YYYY-MM-DD`
 * @param festivals 全部節日（呼叫端給 `TAIWAN_FESTIVALS`）
 */
export function buildFestivalOutcomes(
  today: string,
  festivals: readonly { id: string, name: string, date: string }[],
  broadcasts: readonly BroadcastOutcome[],
  lookbackDays = OUTCOME_LOOKBACK_DAYS,
): FestivalOutcome[] {
  const now = dateToMs(today)
  if (Number.isNaN(now)) return []

  // 只看已經過去、而且在回看窗內的那幾檔；由遠到近算，才有「上一檔」可以比
  const past = festivals
    .filter((f) => {
      const ms = dateToMs(f.date)
      return !Number.isNaN(ms) && ms < now && now - ms <= lookbackDays * DAY
    })
    .sort((a, b) => dateToMs(a.date) - dateToMs(b.date))

  const out: FestivalOutcome[] = []
  let prev: FestivalOutcome | null = null
  for (const f of past) {
    const one = buildOneOutcome(f, broadcasts, prev)
    out.push(one)
    // ⛔ 只有「真的綁在那一檔上、而且真的有送出」的才能當比較基準——
    //    拿日期猜出來的那些當基準，比出來的是雜訊
    if (one.linked && one.sentTotal > 0) prev = one
  }

  // 回給畫面時由近到遠，最多 OUTCOME_MAX 檔
  return out.reverse().slice(0, OUTCOME_MAX)
}

/** 回顧區的標題。⛔ 一檔都沒有就回空字串（整段不出現）。 */
export function outcomeHeadline(outcomes: readonly FestivalOutcome[]): string {
  if (!outcomes.length) return ''
  const withSend = outcomes.filter(o => o.sentTotal > 0)
  if (!withSend.length) return `最近 ${outcomes.length} 檔你都沒有發推播`
  // ⛔ 一則都對不起來時，標題也不可以講成「這幾檔的結果」
  if (!withSend.some(o => o.linked)) return `最近 ${outcomes.length} 檔前後你發過什麼`
  return `最近 ${outcomes.length} 檔的結果`
}
