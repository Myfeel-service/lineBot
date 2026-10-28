/**
 * 貼標分析的聚合純函式（`D-63`／`D-28` 起家）。
 *
 * `D-155`（2026-10-28）改版後，這裡只剩「標籤整理」那一區要用的四支：每顆標籤幾位、
 * 幾位一顆標籤都沒有、AI 貼標準不準、建了沒用到的標籤。
 * 舊版的「客人自己表現出來的」排行、來源占比、兩兩交集、事件 vs 意圖已經拿掉——
 * 排行把問卷名冊算成「客人自己表現的」，前十全是名冊；新版的意圖與交集在 `shared/friend-report.ts`。
 *
 * ⛔ **這裡不做任何查詢**。呼叫端只掃一趟 `userTags`，把同一批列丟給下面每一支
 * （`D-28` 的關鍵成本決定：人數／名單／交集**一趟掃描同時得出**，不要每張卡各掃一次
 * 分三次付錢）。08-11 讀取費暴衝就是「同一批資料反覆掃」的形狀。
 *
 * ⛔ 每一支只回「算得出來的事實」，不回「看起來沒問題」。掃描撞上限、分母不可信時
 * 一律回 `null` 而不是 0——0 跟「不知道」在畫面上要講不同的話
 * （見記憶 `feedback_filters_must_report_what_they_dropped`）。
 */
import type { TagSuggestionEvent, UserTagSourceType } from './types/tag-broadcast'

/**
 * 一趟掃描最多讀幾筆 `userTags`。
 *
 * 為什麼要有上限：這是「掃全工作區的貼標」，沒有上限的話它會跟著資料一起長
 * （08-11 讀取費暴衝就是這種形狀）。⚠️ 2026-10-28 MYFEEL 已經 9,404 筆，原本的一萬只剩 6% 餘裕，
 * 拉到兩萬（一份報告多付的讀取費約台幣三毛，而且有一小時冷卻擋著）。
 * ⛔ 撞到上限**一定要把 `truncated` 帶回畫面**：覆蓋率的分母會因此不可信，
 * 那時要講「算不出來」而不是給一個錯的數字（見 `aggregateCoverage`）。
 */
export const TAG_INSIGHTS_SCAN_LIMIT = 20000

/**
 * AI 建議底帳一次最多讀幾筆。
 *
 * ⛔ 這本帳 2026-08-30 才開始寫（`2198c10`），所以現在整本都讀得完；
 * 之後長大要改成「只看最近 N 天」時**才**需要一支 `(workspaceId, createdAt)` 複合索引——
 * 現在的查詢只有 `workspaceId` 一個等值條件，吃 Firestore 自動的單欄位索引就夠，
 * ⛔ 不要為了「以後可能會用到」先去部署一支沒人用的複合索引。
 */
export const TAG_SUGGESTION_LOG_SCAN_LIMIT = 5000

/** 一趟掃描要取的欄位 */
export interface UserTagRow {
  userId: string
  tagId: string
  sourceType: UserTagSourceType
}

function normalizeRows<T extends { userId: string, tagId: string }>(rows: readonly T[]): T[] {
  return rows.filter(r => r && typeof r.userId === 'string' && r.userId && typeof r.tagId === 'string' && r.tagId)
}

/**
 * 每顆標籤有幾位客人（不分來源）——就是標籤頁「好友數」那一欄的口徑。
 *
 * ⛔ 以 `userId` 去重：同一個人同一顆標籤在正常情況下只有一份文件
 * （doc id 是 `${userId}_${tagId}`），但這裡仍去重，不靠上游保證。
 */
export function memberCountsFromRows<T extends { userId: string, tagId: string }>(rows: readonly T[]): Record<string, number> {
  const seen = new Map<string, Set<string>>()
  for (const r of normalizeRows(rows)) {
    if (!seen.has(r.tagId)) seen.set(r.tagId, new Set())
    seen.get(r.tagId)!.add(r.userId)
  }
  const out: Record<string, number> = {}
  for (const [tagId, users] of seen) out[tagId] = users.size
  return out
}

/**
 * 標籤覆蓋率：有幾位客人身上至少有一顆標籤、有幾位一顆都沒有。
 *
 * ⛔ **分母誠信**：`totalUsers` 是好友名單裡的人數，而名單**只收得到互動過的人**
 *   （從沒講過話的好友根本不在庫裡）。畫面上一律寫「名單」或「有互動的客人」，不可以寫「好友」。
 * ⛔ `truncated`（掃描撞上限）時 `untaggedUsers` 與 `pct` 一律回 `null`：
 *   掃到一半的名單算出來的「沒有標籤的人數」是錯的，寧可講「算不出來」。
 */
export function aggregateCoverage<T extends { userId: string, tagId: string }>(
  rows: readonly T[],
  totalUsers: number | null,
  opts: { truncated?: boolean } = {},
): { taggedUsers: number, untaggedUsers: number | null, totalUsers: number | null, pct: number | null } {
  const tagged = new Set<string>()
  for (const r of normalizeRows(rows)) tagged.add(r.userId)
  const taggedUsers = tagged.size
  const usable = !opts.truncated && typeof totalUsers === 'number' && totalUsers > 0
  if (!usable) return { taggedUsers, untaggedUsers: null, totalUsers: totalUsers ?? null, pct: null }
  // 掃描沒截斷時仍可能出現 tagged > total（名單剛好在兩次查詢之間變動）→ 夾住不要回負數
  const untagged = Math.max(0, totalUsers - taggedUsers)
  return {
    taggedUsers,
    untaggedUsers: untagged,
    totalUsers,
    pct: Math.round((Math.min(taggedUsers, totalUsers) / totalUsers) * 1000) / 10,
  }
}

/**
 * AI 貼標建議的成績（唯一吃 `tagSuggestionLogs` 的一支）。
 *
 * ⛔ 三條口徑紅線，寫錯就會騙人（型別註解已經明講，這裡照做）：
 *  ① `superseded`（建議還掛著、人自己走「管理標籤」貼了同一顆）**算同意**——
 *    客服習慣自己加標籤、不走採用鈕，漏掉它會低報準確率。
 *  ② `auto_applied`（該顆設成「AI 判到直接貼」）**不能算進採用率**：那些沒有人投票，
 *    算進去等於自動送 100% 分。單獨回一個數字讓畫面另外講。
 *  ③ 分母是**人真的做過決定的那些**（採用＋忽略＋自己貼），不是「AI 提過幾次」——
 *    還在收件匣等人決定的不該拉低分數。
 *
 * ⚠️ 畫面上**不要並列「AI 提過幾次」**：「提過」8/30 才開始記，8/23–8/29 提的建議很多是 8/30 之後
 *   才被決定，於是「提過 77 次、人決定了 142 次」——分子分母不同期，讀起來像算錯（`D-155` 盤點）。
 * ⛔ 回傳的東西**不可以拿去跟收件匣的「待審 N 位」相加或對帳**：兩本帳問的問題不同。
 */
export function aggregateSuggestionOutcomes(
  events: ReadonlyArray<{ event: TagSuggestionEvent }>,
): {
  suggested: number
  autoApplied: number
  applied: number
  dismissed: number
  superseded: number
  decided: number
  agreed: number
  /** 同意率；還沒有人做過任何決定時回 null（不是 0——那會被讀成「AI 全錯」） */
  acceptanceRate: number | null
} {
  const c = { suggested: 0, auto_applied: 0, applied: 0, dismissed: 0, superseded: 0 } as Record<TagSuggestionEvent, number>
  for (const e of events) {
    const k = e?.event
    if (k && k in c) c[k] += 1
  }
  const agreed = c.applied + c.superseded
  const decided = agreed + c.dismissed
  return {
    suggested: c.suggested,
    autoApplied: c.auto_applied,
    applied: c.applied,
    dismissed: c.dismissed,
    superseded: c.superseded,
    decided,
    agreed,
    acceptanceRate: decided > 0 ? Math.round((agreed / decided) * 1000) / 10 : null,
  }
}

/** 健康檢查要用的最小標籤形狀 */
export interface TagLike {
  id: string
  name?: string
  status?: string
  aiMode?: string
}

/**
 * 標籤健康檢查：列出「建了沒用到」與「開著 AI 判斷卻從來沒判出人」的標籤。
 *
 * ⛔ **只列出來建議，不自動刪不自動合併**：標籤貼在真人身上（`D-60` 的原則）。
 * ⛔ 「疑似重複」不在這裡做——`D-62` 已經有一套重複偵測，另做一套就是同一件事兩種答案。
 */
export function findTagHealthIssues(
  tags: readonly TagLike[],
  memberCounts: Readonly<Record<string, number>>,
  aiProducedTagIds: ReadonlySet<string>,
): { zeroMember: TagLike[], aiOnButNeverProduced: TagLike[] } {
  const active = tags.filter(t => t && t.id && t.status !== 'inactive')
  return {
    zeroMember: active.filter(t => (memberCounts[t.id] ?? 0) === 0),
    // 缺欄位＝off 是全系統口徑，所以只認明寫 suggest／auto 的
    aiOnButNeverProduced: active.filter(
      t => (t.aiMode === 'suggest' || t.aiMode === 'auto') && !aiProducedTagIds.has(t.id),
    ),
  }
}
