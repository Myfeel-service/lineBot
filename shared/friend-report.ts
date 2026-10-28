/**
 * 好友統計報告（`D-155`，2026-10-28 老闆「好執行」）——事實層的形狀與純函式。
 *
 * ── 這一版在回答什麼 ─────────────────────────────────────────────
 * 舊版（`D-28`／`D-63` Phase 1）回答的是「標籤系統健不健康」：7 張卡有 5 張在講標籤本身，
 * 排行把問卷自動貼的名冊也算成「客人自己表現的」，前十全是名冊，AI 判出來的意圖一顆都排不上。
 * 這一版回答店家會問的四件事：客人最近在想什麼、推播發給誰有反應、新的人從哪裡來、接下來該做什麼。
 * 報告＝`docs/FRIEND-STATS-REDESIGN-EVAL-20261028.md`。
 *
 * ── 這一層只放「算得出來的事實」──────────────────────────────────
 * 「接下來該做什麼」（行銷提案、也要留意）是**照這些事實套規則**算出來的，在
 * `shared/friend-report-advice.ts`；⛔ 不要把判斷寫進這裡，也不要讓 AI 碰任何一個數字。
 *
 * ⛔ 三態照舊：查不到回 `null`，⛔ 不可以用 0 代替（0 位跟「查不到」在畫面上要講不同的話）。
 * ⛔ 這裡不做查詢。呼叫端（`server/utils/friend-report-compute.ts`）只掃一趟 `userTags`，
 *   同一批列丟給下面每一支（`D-28` 的成本決定照舊）。
 */
import { followUpAudienceText, isFollowUpTarget } from './broadcast-follow-up'
import { LINE_STATS_ROUND_DAYS } from './broadcast-line-stats'
import { pickPreviousSameAudience, wasSent, type AudienceLike } from './broadcast-open-compare'
import { addDays, daysBetween, taipeiDate } from './time'
import type { TagCategory } from './types/tag-broadcast'

/** 存檔裡的版本號。舊版報告（沒有這一欄）畫面上要請他重新產生，⛔ 不可以硬畫成空的 */
export const FRIEND_REPORT_VERSION = 2

/** 報告看幾天、跟前面幾天比 */
export const REPORT_WINDOW_DAYS = 30

/** 推播送到幾人以上才列進「推播發給誰最有反應」（試發給自己那種 1 人的不列） */
export const PUSH_MIN_SENT = 20

/** 交集至少幾位才講（兩三個人的交集是雜訊；比舊版的 5 低，因為這裡只算最近 30 天新增的人） */
export const PAIR_MIN_USERS = 3

/** 新進名單來源列前幾名，其餘併成「其他 N 種」 */
export const NEW_MEMBER_TOP_SOURCES = 4

const DAY = 86_400_000

// ═══════════════════════════════════════════════════════════════════
//  時間窗
// ═══════════════════════════════════════════════════════════════════

export interface ReportWindow {
  /** 窗口開頭（台北 00:00，含）＝`endMs` 往前 30 天 */
  startMs: number
  /** 窗口結尾（台北今天 00:00，不含）——只算到昨天，今天還沒過完 */
  endMs: number
  /** 前一個窗口的開頭（比較用） */
  prevStartMs: number
  /** 給人看的日期（台北，含頭含尾）：例 2026-09-28 ～ 2026-10-27 */
  startDate: string
  endDate: string
}

/**
 * 最近 30 天＝台北的日曆日、到昨天為止。
 * ⛔ 不用「現在往回 30×24 小時」：同一天不同時間按產生，數字會漂、跟別頁對不起來（`G-22`① 同一個教訓）。
 */
export function reportWindow(nowMs: number): ReportWindow {
  const today = taipeiDate(new Date(nowMs))
  const endMs = Date.parse(`${today}T00:00:00+08:00`)
  const startMs = endMs - REPORT_WINDOW_DAYS * DAY
  return {
    startMs,
    endMs,
    prevStartMs: startMs - REPORT_WINDOW_DAYS * DAY,
    startDate: addDays(today, -REPORT_WINDOW_DAYS),
    endDate: addDays(today, -1),
  }
}

/** 「2026-09-28」→「9/28」 */
export function md(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return m && d ? `${m}/${d}` : date
}

/** 毫秒 → 台北的「9/28」 */
export function mdOfMs(ms: number): string {
  return md(taipeiDate(new Date(ms)))
}

/**
 * 毫秒 → **日本時間**的日期（LINE 的統計用日本時間切一天）。
 * 推播日要跟 LINE 的每日封鎖數對在同一天，所以這裡刻意不用台北日期。
 */
export function lineDayOfMs(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10)
}

/** 千分位（`10810` → `10,810`）。⛔ 舊版大數字沒有千分位，被讀成算錯過 */
export function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

// ═══════════════════════════════════════════════════════════════════
//  報告的形狀
// ═══════════════════════════════════════════════════════════════════

export interface IntentTagStat {
  tagId: string
  name: string
  category: TagCategory | null
  /** 這顆標籤目前幾位（不分來源）——「發推播給這群」按下去發的就是這些人 */
  members: number
  /** 最近 30 天新被貼上的人數 */
  recent: number
  /** 前 30 天新被貼上的人數 */
  prev: number
  /** 目前這些人裡，最近 30 天一則推播都沒收過的；推播讀不到＝null */
  notPushedRecent: number | null
  /** 目前這些人裡，最近 7 天收過推播的；推播讀不到＝null */
  pushedWithin7d: number | null
}

export interface IntentPair {
  a: string
  b: string
  /** 兩顆都是最近 30 天新被貼上的人數 */
  users: number
}

export interface PushRow {
  id: string
  name: string
  completedMs: number
  /** `label`＝表格「發給」那一欄的字（標籤名、全部好友、補發給哪一則的誰…） */
  audience: { type: string, tagIds: string[], tagNames: string[], label: string }
  sent: number
  /** LINE 統計的人數；沒給＝null（⛔ 不是 0） */
  opened: number | null
  clicked: number | null
  /** 從好友統計的行銷提案開的那一則才有（提案的那顆標籤） */
  proposalTagId: string | null
  /** 上一則發給同一群人的（`D-154`①／`C-401` 同一支判斷）；沒有或那一則沒打開數＝null */
  prevOpen: { name: string, completedMs: number, openRate: number } | null
  /**
   * LINE 的數字定了沒＝排程已經存到最後一輪（發完第 7 天那次，`StoredLineStats.round`）。
   * ⛔ 不要用「發完過了幾天」代替：滿 7 天但排程還沒抓、或抓失敗 6 小時後才重試的那段，存的還是第 3 天的數字（code review 抓到）。
   * ⚠️ 舊存檔沒有這一欄＝退回看天數（`pushStatsFinal`）。
   */
  statsFinal?: boolean
}

export interface LineFriendStats {
  /** ok＝頭尾都拿到；partial＝最後一天 LINE 還沒算好、改用拿得到的最近一天；no_token／failed＝整格沒有 */
  status: 'ok' | 'partial' | 'no_token' | 'failed'
  /** 加過好友的人次（LINE 的 `followers`：累計，封鎖了也不會減） */
  followers: number | null
  followersDelta: number | null
  blocks: number | null
  blocksDelta: number | null
  /** 數字是哪一天的（日本時間）；partial 時會比窗口最後一天早 */
  asOfDate: string | null
  /** 每天多封鎖幾位（日本時間的日期）；LINE 那天沒給就不在表裡 */
  blocksByDay: Record<string, number>
}

export interface NewMemberSourceRow {
  kind: 'tag' | 'other' | 'none'
  tagId: string | null
  name: string
  users: number
}

export interface NewMemberSources {
  /** 這 30 天第一次進名單的人數；查不到＝null */
  total: number | null
  truncated: boolean
  rows: NewMemberSourceRow[]
}

export interface FriendReportPayload {
  version: typeof FRIEND_REPORT_VERSION
  /**
   * 產生的那一刻（毫秒）。窗口只算到昨天，但「今天剛發的推播」「發完還不到 7 天的數字」要拿這個比（`C-404`）。
   * 舊存檔沒有這一欄＝退回窗口結尾。
   */
  generatedAtMs?: number
  window: ReportWindow
  /** ⛔ 畫面一定要讀這一段：哪幾塊算不出來、哪幾塊只算了一部分 */
  integrity: {
    failed: string[]
    /**
     * 標籤／貼標紀錄讀不到（`C-404`）。⛔ 讀不到時下面每一區都不可以照空資料下結論
     * （「還沒有標籤開 AI 判斷」「每顆都建了沒人用」都是假的），要講「這次讀不到」。
     */
    tagsFailed?: boolean
    userTagsFailed?: boolean
    /** 推播只往回讀到一定則數；連窗口開頭都沒讀到＝窗口裡的推播可能沒列全 */
    pushesTruncated?: boolean
    userTagsTruncated: boolean
    scannedUserTags: number
    suggestionLogsTruncated: boolean
    pendingTruncated: boolean
    newMembersTruncated: boolean
    /** 建議底帳起算日（AI 準不準要標它） */
    suggestionLedgerSince: string
  }
  overview: {
    line: LineFriendStats
    /** 最近 30 天有互動（傳訊息、按選單或按鈕，`C-401` 同口徑）的人數 */
    activeUsers: number | null
    /** 名單（`users`）總人數＝互動過的人，⛔ 不是 LINE 好友數 */
    listSize: number | null
  }
  /** 有開 AI 判斷的標籤（意圖），⛔ 問卷／活動名冊不在這裡——它們在推播與新進名單兩區當受眾與來源 */
  intents: IntentTagStat[]
  intentPairs: IntentPair[]
  /** 最近 30 天的推播；讀不到＝null */
  pushes: PushRow[] | null
  newMembers: NewMemberSources
  /** 行銷提案搭的檔期（伺服器端照行事曆挑，見 `pickProposalFestival`）；沒有＝null */
  upcomingFestival: { id: string, name: string, date: string } | null
  housekeeping: {
    zeroMember: Array<{ tagId: string, name: string }>
    aiOnButNeverProduced: Array<{ tagId: string, name: string }>
    /** 名單裡一顆標籤都沒有的人；掃描截斷或名單人數查不到＝null */
    untaggedUsers: number | null
    /**
     * AI 建議的同意率；**AI 建議紀錄讀不到＝null**（⛔ 不是「還沒有人決定過」——那是讀得到、真的沒有，code review 抓到）。
     * ⚠️ 舊存檔一定有值（讀不到的時候也照 0 存了），畫面照讀。
     */
    suggestions: { decided: number, agreed: number, autoApplied: number, acceptanceRate: number | null } | null
    /** 等人決定的 AI 建議人數；**待審建議讀不到＝null**（⛔ 不是「沒有」） */
    pendingUsers: number | null
  }
}

// ═══════════════════════════════════════════════════════════════════
//  意圖標籤：最近 30 天 vs 前 30 天
// ═══════════════════════════════════════════════════════════════════

export interface UserTagTimedRow {
  userId: string
  tagId: string
  /** 被貼上的時間；舊資料沒有＝null（⛔ 不算進任何一個窗口，也不猜） */
  createdAtMs: number | null
}

export interface IntentTagLike {
  id: string
  name?: string
  category?: string | null
  aiMode?: string
  status?: string
}

/** 有開 AI 判斷的標籤（不管有沒有封存）。缺欄位＝off 是全系統口徑 */
export function isAiTag(t: IntentTagLike): boolean {
  return t.aiMode === 'suggest' || t.aiMode === 'auto'
}

/** 有開 AI 判斷、而且還在用的標籤＝意圖 */
export function isIntentTag(t: IntentTagLike): boolean {
  return isAiTag(t) && t.status !== 'inactive'
}

/** 報告的「現在」：產生那一刻；舊存檔沒有就用窗口結尾 */
export function reportNowMs(p: { generatedAtMs?: number, window: ReportWindow }): number {
  return typeof p.generatedAtMs === 'number' && p.generatedAtMs > 0 ? p.generatedAtMs : p.window.endMs
}

/** 讀不到標籤或貼標紀錄＝跟標籤有關的每一區都不可以下結論 */
export function tagDataUnavailable(p: Pick<FriendReportPayload, 'integrity'>): boolean {
  return !!(p.integrity.tagsFailed || p.integrity.userTagsFailed)
}

function inRange(ms: number | null, from: number, to: number): boolean {
  return ms !== null && ms >= from && ms < to
}

/**
 * 每顆意圖標籤：目前幾位、最近 30 天新增、前 30 天新增、這些人最近有沒有收過推播。
 *
 * `pushed` 是最近 30 天／7 天收過推播的人（推播存的收件名單）；讀不到推播傳 `null`，
 * 兩個推播欄位就回 `null`——⛔ 不可以當成「都沒收過」。
 */
export function intentTagStats(
  rows: readonly UserTagTimedRow[],
  tags: readonly IntentTagLike[],
  win: ReportWindow,
  pushed: { within30: ReadonlySet<string>, within7: ReadonlySet<string> } | null,
): IntentTagStat[] {
  const intents = tags.filter(t => t?.id && isIntentTag(t))
  const wanted = new Set(intents.map(t => t.id))
  const members = new Map<string, Set<string>>()
  const recent = new Map<string, Set<string>>()
  const prev = new Map<string, Set<string>>()
  for (const id of wanted) {
    members.set(id, new Set())
    recent.set(id, new Set())
    prev.set(id, new Set())
  }
  for (const r of rows) {
    if (!r?.userId || !wanted.has(r.tagId)) continue
    members.get(r.tagId)!.add(r.userId)
    if (inRange(r.createdAtMs, win.startMs, win.endMs)) recent.get(r.tagId)!.add(r.userId)
    else if (inRange(r.createdAtMs, win.prevStartMs, win.startMs)) prev.get(r.tagId)!.add(r.userId)
  }
  return intents
    .map((t) => {
      const m = members.get(t.id)!
      let notPushed: number | null = null
      let within7: number | null = null
      if (pushed) {
        notPushed = 0
        within7 = 0
        for (const u of m) {
          if (!pushed.within30.has(u)) notPushed++
          if (pushed.within7.has(u)) within7++
        }
      }
      return {
        tagId: t.id,
        name: String(t.name ?? ''),
        category: (t.category ?? null) as TagCategory | null,
        members: m.size,
        recent: recent.get(t.id)!.size,
        prev: prev.get(t.id)!.size,
        notPushedRecent: notPushed,
        pushedWithin7d: within7,
      }
    })
    // 最近新增多的在前（同數照目前人數、再照 id，重算時順序不跳）
    .sort((a, b) => b.recent - a.recent || b.members - a.members || a.tagId.localeCompare(b.tagId))
}

/**
 * 兩顆意圖標籤都是「最近 30 天新被貼上」的人數（例：在看咖啡機 ∩ 問過價格優惠＝7 位）。
 * ⛔ 只算最近的：一年前問過價格、上週在看咖啡機的人，不是「最近在看又問了價格」。
 */
export function recentIntentPairs(
  rows: readonly UserTagTimedRow[],
  intentTagIds: readonly string[],
  win: ReportWindow,
  minUsers = PAIR_MIN_USERS,
): IntentPair[] {
  const ids = [...new Set(intentTagIds)]
  const sets = new Map<string, Set<string>>(ids.map(id => [id, new Set<string>()]))
  for (const r of rows) {
    const s = sets.get(r?.tagId)
    if (s && r.userId && inRange(r.createdAtMs, win.startMs, win.endMs)) s.add(r.userId)
  }
  const out: IntentPair[] = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = sets.get(ids[i]!)!
      const B = sets.get(ids[j]!)!
      const [small, big] = A.size <= B.size ? [A, B] : [B, A]
      let n = 0
      for (const u of small) if (big.has(u)) n++
      if (n >= minUsers) out.push({ a: ids[i]!, b: ids[j]!, users: n })
    }
  }
  return out.sort((x, y) => y.users - x.users || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
}

// ═══════════════════════════════════════════════════════════════════
//  新進名單從哪裡來
// ═══════════════════════════════════════════════════════════════════

/**
 * 這 30 天第一次進名單的人，照他身上**最早的一顆來源標籤**分組。
 *
 * 來源標籤＝不是 AI 判的、也不是「N 天沒互動」那顆的標籤（問卷、活動、客服按鈕貼的）。
 * ⛔ 意圖不算來源：「在看咖啡機」是他進來之後講的話，不是他從哪裡來。
 *   ⚠️ **封存掉的 AI 標籤也一樣不算**（`C-404`）：封存不會把它從客人身上拿掉，只看「還在用」的話它會被當成來源。
 * ⛔ 刪掉的標籤（`tags` 裡找不到）不猜名字，當成沒有。
 *
 * ⚠️ 母數跟對話統計「新加好友」同一個（`users.createdAt`），**不是** LINE 的新加好友——
 *   以前就是好友、這次第一次填問卷的也在裡面（`H-44`）。畫面要講這件事。
 */
export function newMemberSources(
  newUserIds: ReadonlySet<string>,
  rows: readonly UserTagTimedRow[],
  tags: readonly (IntentTagLike & { code?: string })[],
  opts: { excludeTagIds?: readonly string[], top?: number } = {},
): NewMemberSourceRow[] {
  const top = opts.top ?? NEW_MEMBER_TOP_SOURCES
  const excluded = new Set(opts.excludeTagIds ?? [])
  const byId = new Map(tags.map(t => [t.id, t]))
  const first = new Map<string, { tagId: string, at: number }>()
  for (const r of rows) {
    if (!r?.userId || !newUserIds.has(r.userId)) continue
    const t = byId.get(r.tagId)
    if (!t || excluded.has(t.id) || isAiTag(t)) continue
    // 沒有時間的排最後（⛔ 不當成最早）
    const at = r.createdAtMs ?? Number.POSITIVE_INFINITY
    const cur = first.get(r.userId)
    if (!cur || at < cur.at || (at === cur.at && r.tagId < cur.tagId)) first.set(r.userId, { tagId: r.tagId, at })
  }
  const counts = new Map<string, number>()
  for (const { tagId } of first.values()) counts.set(tagId, (counts.get(tagId) ?? 0) + 1)
  const ranked = [...counts.entries()]
    .map(([tagId, users]) => ({ tagId, users, name: String(byId.get(tagId)?.name ?? '') }))
    .sort((a, b) => b.users - a.users || a.name.localeCompare(b.name))

  const out: NewMemberSourceRow[] = ranked.slice(0, top).map(r => ({ kind: 'tag', tagId: r.tagId, name: r.name, users: r.users }))
  const rest = ranked.slice(top)
  if (rest.length) {
    out.push({ kind: 'other', tagId: null, name: `其他 ${rest.length} 種`, users: rest.reduce((s, r) => s + r.users, 0) })
  }
  const none = newUserIds.size - first.size
  if (none > 0) out.push({ kind: 'none', tagId: null, name: '沒有來源標籤', users: none })
  return out
}

// ═══════════════════════════════════════════════════════════════════
//  推播
// ═══════════════════════════════════════════════════════════════════

export interface BroadcastLite {
  id: string
  name: string
  status: string
  completedMs: number | null
  audienceSource: (NonNullable<AudienceLike> & { sourceBroadcastId?: string, followUpTarget?: string, sourceName?: string }) | null
  sentCount: number
  opened: number | null
  clicked: number | null
  proposalTagId: string | null
  /** 收件名單；只有用得到的那幾則才讀（窗口內送出的＋補發的來源那一則，`C-404`），其餘是空陣列 */
  resolvedUserIds: readonly string[]
  /** LINE 的數字已經存到最後一輪（見 `PushRow.statsFinal`）；沒給＝false */
  statsFinal?: boolean
}

/** 真的送出去、送到人、而且知道哪時候送完的（「送出去」的判斷跟推播成效頁同一支 `wasSent`） */
function sentWithTime(b: BroadcastLite): boolean {
  return wasSent(b) && b.completedMs !== null
}

/** 標籤名稱這次讀不到時，依標籤發的推播「發給」那一欄寫這個（⛔ 不寫「已刪除的標籤」——沒刪，是沒讀到） */
export const TAG_NAMES_UNREADABLE_LABEL = '依標籤挑的人（標籤名稱這次讀不到）'

/**
 * 「發給」那一欄的字。補發（`C-403`）講得出補發給哪一則的誰，⛔ 不要寫成看不懂的「指定名單」。
 * 補發那一句跟推播頁同一支（`followUpAudienceText`）：⛔ 不要在這裡另寫一份——
 * 以前這裡一律寫「補發給」，「點了連結的人」那則跟推播頁講的不一樣（code review 抓到）。
 */
export function pushAudienceLabel(
  src: BroadcastLite['audienceSource'],
  tagNames: readonly string[],
): string {
  if (src?.type === 'tags') return tagNames.length ? tagNames.join('、') : TAG_NAMES_UNREADABLE_LABEL
  if (src?.type === 'all') return '全部好友'
  if (src?.type === 'followUp') {
    return followUpAudienceText(src.sourceName, isFollowUpTarget(src.followUpTarget) ? src.followUpTarget : undefined)
  }
  if (src?.type === 'import') return '匯入的名單'
  return '指定名單'
}

/** LINE 的數字定了沒：有存輪次就看輪次；舊存檔沒有這一欄才退回看發完過了幾天 */
export function pushStatsFinal(row: { statsFinal?: boolean, completedMs: number }, nowMs: number): boolean {
  if (typeof row.statsFinal === 'boolean') return row.statsFinal
  // 最後一輪＝發完第 7 天（`[2]` 是固定位置，型別就是 7；⛔ 不用 `[length - 1]`，那個型別會帶 undefined）
  return nowMs - row.completedMs >= LINE_STATS_ROUND_DAYS[2] * DAY
}

/**
 * 最近 30 天的推播列（新到舊），**含今天已經送完的**（`C-404`：只算到昨天的話，
 * 今天剛發的推播不在表上，提案的「7 天內收過推播就不提」也看不到它）。
 * `all` 是讀進來的全部推播（含窗口之前的）——「上一則發給同一群人的」可能在窗口外。
 * `tagNameOf` 傳 null＝**標籤這次讀不到**：依標籤發的那幾則寫「標籤名稱這次讀不到」，
 *   ⛔ 不可以照「查無此標籤」寫成「(已刪除的標籤)」——讓店家以為標籤被刪了（code review 抓到）。
 */
export function pushRows(
  all: readonly BroadcastLite[],
  win: ReportWindow,
  tagNameOf: ((tagId: string) => string | null) | null,
  nowMs: number,
): PushRow[] {
  const candidates = all.map(b => ({
    id: b.id,
    name: b.name,
    status: b.status,
    audienceSource: b.audienceSource,
    sentCount: b.sentCount,
    opened: b.opened,
    completedMs: b.completedMs,
  }))
  return all
    .filter(b => sentWithTime(b) && b.sentCount >= PUSH_MIN_SENT && inRange(b.completedMs, win.startMs, nowMs))
    .sort((a, b) => b.completedMs! - a.completedMs!)
    .map((b) => {
      const tagIds = b.audienceSource?.type === 'tags' ? [...(b.audienceSource.tagIds ?? [])] : []
      // 刪掉的標籤不猜名字；標籤整個讀不到時不列名字（「發給」那一欄另外講）
      const tagNames = tagNameOf ? tagIds.map(id => tagNameOf(id) ?? '(已刪除的標籤)') : []
      const prev = pickPreviousSameAudience({ id: b.id, audienceSource: b.audienceSource, completedMs: b.completedMs! }, candidates)
      return {
        id: b.id,
        name: b.name,
        completedMs: b.completedMs!,
        audience: {
          type: String(b.audienceSource?.type ?? ''),
          tagIds,
          tagNames,
          label: pushAudienceLabel(b.audienceSource, tagNames),
        },
        sent: b.sentCount,
        opened: b.opened,
        clicked: b.clicked,
        proposalTagId: b.proposalTagId,
        prevOpen: prev ? { name: prev.name, completedMs: prev.completedMs, openRate: prev.openRate } : null,
        statsFinal: b.statsFinal === true,
      }
    })
}

/** 這幾則推播的收件名單要讀：窗口內（含今天）送出的，加上補發所補的那一則（補發自己沒有名單） */
export function recipientIdsNeeded(all: readonly BroadcastLite[], win: ReportWindow, nowMs: number): string[] {
  const out = new Set<string>()
  for (const b of all) {
    if (!sentWithTime(b) || !inRange(b.completedMs, win.startMs, nowMs)) continue
    out.add(b.id)
    if (b.audienceSource?.type === 'followUp' && b.audienceSource.sourceBroadcastId) out.add(b.audienceSource.sourceBroadcastId)
  }
  return [...out]
}

/**
 * 最近 30 天／7 天收過推播的人（推播存的收件名單 `audienceSnapshot.resolvedUserIds`）。
 * ⛔ 試發不在這裡（試發不寫收件名單）；1 人的正式推播算——那個人真的收到了。
 * ⛔ **算到產生那一刻**，不是昨天（`C-404`）：早上照提案發了，中午重新產生，這群人要算「7 天內收過」，
 *   不然同一則提案又出現、叫他同一天再發一次。
 * ⚠️ 補發（`C-403`）LINE 不給名單，用**它補的那一則的名單**代替——那是收件人的「上限」，
 *   寧可多算成收過（提案會保守一點），⛔ 也不要當成誰都沒收到。
 * `bySourceId` 是補發要用的「那一則」的名單（可能在窗口外）。
 */
export function pushedUserSets(
  all: readonly BroadcastLite[],
  win: ReportWindow,
  nowMs: number,
): { within30: Set<string>, within7: Set<string> } {
  const within30 = new Set<string>()
  const within7 = new Set<string>()
  const sevenStart = nowMs - 7 * DAY
  const byId = new Map(all.map(b => [b.id, b]))
  for (const b of all) {
    if (!sentWithTime(b) || !inRange(b.completedMs, win.startMs, nowMs)) continue
    const recipients = b.audienceSource?.type === 'followUp' && !b.resolvedUserIds.length
      ? byId.get(String(b.audienceSource.sourceBroadcastId ?? ''))?.resolvedUserIds ?? []
      : b.resolvedUserIds
    for (const u of recipients) {
      within30.add(u)
      if (b.completedMs! >= sevenStart) within7.add(u)
    }
  }
  return { within30, within7 }
}

// ═══════════════════════════════════════════════════════════════════
//  LINE 好友數、封鎖
// ═══════════════════════════════════════════════════════════════════

export interface LineFollowerDay {
  followers: number
  blocks: number
}

/** 要問 LINE 哪幾天（日本時間）：窗口前一天（算增減的基準）到窗口最後一天 */
export function lineQueryDates(win: ReportWindow): string[] {
  const out: string[] = []
  for (let d = addDays(win.startDate, -1); daysBetween(d, win.endDate) >= 0; d = addDays(d, 1)) out.push(d)
  return out
}

/**
 * LINE 每天的數字 → 最上面兩格＋每天封鎖幾位。
 *
 * ⛔ 某天 LINE 沒給（還沒算好、或那天問失敗）：那天不在 `blocksByDay` 裡，⛔ 不補 0；
 *   隔天的增減也算不出來（要前後兩天都有）。
 * ⚠️ 窗口最後一天常常還沒算好（LINE 隔天才出前一天的數字）→ 用拿得到的最近一天，狀態標 partial。
 */
export function lineFriendStats(
  byDate: Readonly<Record<string, LineFollowerDay | null>>,
  dates: readonly string[],
): LineFriendStats {
  const blocksByDay: Record<string, number> = {}
  for (let i = 1; i < dates.length; i++) {
    const a = byDate[dates[i - 1]!]
    const b = byDate[dates[i]!]
    if (a && b) blocksByDay[dates[i]!] = Math.max(0, b.blocks - a.blocks)
  }
  const base = dates.length ? byDate[dates[0]!] ?? null : null
  let asOf: string | null = null
  for (let i = dates.length - 1; i >= 1; i--) {
    if (byDate[dates[i]!]) { asOf = dates[i]!; break }
  }
  if (!asOf) {
    return { status: 'failed', followers: null, followersDelta: null, blocks: null, blocksDelta: null, asOfDate: null, blocksByDay }
  }
  const last = byDate[asOf]!
  return {
    status: asOf === dates[dates.length - 1] ? 'ok' : 'partial',
    followers: last.followers,
    followersDelta: base ? last.followers - base.followers : null,
    blocks: last.blocks,
    blocksDelta: base ? last.blocks - base.blocks : null,
    asOfDate: asOf,
    blocksByDay,
  }
}

/**
 * 平常一天封鎖幾位＝沒發推播的日子的中位數。
 * 推播當天與隔天都排除（MYFEEL 9/29 發完，9/30 還在封鎖 30 位）；剩不到 5 天＝null（太少，不講平常）。
 */
export function blockBaseline(blocksByDay: Readonly<Record<string, number>>, pushDays: ReadonlySet<string>): number | null {
  const skip = new Set<string>()
  for (const d of pushDays) {
    skip.add(d)
    skip.add(addDays(d, 1))
  }
  const vals = Object.entries(blocksByDay).filter(([d]) => !skip.has(d)).map(([, v]) => v).sort((a, b) => a - b)
  if (vals.length < 5) return null
  const mid = Math.floor(vals.length / 2)
  return vals.length % 2 ? vals[mid]! : Math.round((vals[mid - 1]! + vals[mid]!) / 2)
}
