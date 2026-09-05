/**
 * 貼標分析的聚合純函式（`D-63`／`D-28`）。
 *
 * 為什麼全部抽成純函式：測試不用碰 Firestore，而且**版面還沒拍板**——
 * 獨立頁或掛在好友頁頂部，吃的都是同一批數字，先把算得對的部分做完。
 *
 * ⛔ **這裡不做任何查詢**。呼叫端只掃一趟 `userTags`，把同一批列丟給下面每一支
 * （`D-28` 的關鍵成本決定：人數／名單／交集**一趟掃描同時得出**，不要每張卡各掃一次
 * 分三次付錢）。08-11 讀取費暴衝就是「同一批資料反覆掃」的形狀。
 *
 * ⛔ 每一支只回「算得出來的事實」，不回「看起來沒問題」。掃描撞上限、分母不可信時
 * 一律回 `null` 而不是 0——0 跟「不知道」在畫面上要講不同的話
 * （見記憶 `feedback_filters_must_report_what_they_dropped`）。
 */
import { countsAsCustomerHit } from './tag-admin'
import type { TagSuggestionEvent, UserTagSourceType } from './types/tag-broadcast'

/**
 * 一趟掃描最多讀幾筆 `userTags`。
 *
 * 為什麼要有上限：這是「掃全工作區的貼標」，沒有上限的話它會跟著資料一起長
 * （08-11 讀取費暴衝就是這種形狀）。今天 MYFEEL 約 2,383 筆，一萬筆給了四倍餘裕。
 * ⛔ 撞到上限**一定要把 `truncated` 帶回畫面**：覆蓋率的分母會因此不可信，
 * 那時要講「算不出來」而不是給一個錯的百分比（見 `aggregateCoverage`）。
 */
export const TAG_INSIGHTS_SCAN_LIMIT = 10000

/**
 * AI 建議底帳一次最多讀幾筆。
 *
 * ⛔ 這本帳 2026-08-30 才開始寫（`2198c10`），所以現在整本都讀得完；
 * 之後長大要改成「只看最近 N 天」時**才**需要一支 `(workspaceId, createdAt)` 複合索引——
 * 現在的查詢只有 `workspaceId` 一個等值條件，吃 Firestore 自動的單欄位索引就夠，
 * ⛔ 不要為了「以後可能會用到」先去部署一支沒人用的複合索引。
 */
export const TAG_SUGGESTION_LOG_SCAN_LIMIT = 5000

/** 一趟掃描要取的欄位（`.select()` 只撈這三個，別把整份文件撈回來） */
export interface UserTagRow {
  userId: string
  tagId: string
  sourceType: UserTagSourceType
}

/** 五種來源固定順序（畫面照這個順序排，別讓它隨資料浮動） */
export const TAG_SOURCE_ORDER: UserTagSourceType[] = ['ai', 'rule', 'system', 'manual', 'import']

export const TAG_SOURCE_LABELS: Record<UserTagSourceType, string> = {
  ai: 'AI 從對話判斷',
  rule: '規則觸發',
  system: '系統事件',
  manual: '我們自己貼的',
  import: '名單匯入',
}

function normalizeRows(rows: readonly UserTagRow[]): UserTagRow[] {
  return rows.filter(r => r && typeof r.userId === 'string' && r.userId && typeof r.tagId === 'string' && r.tagId)
}

/**
 * 每顆標籤有幾位客人（不分來源）——就是標籤頁「好友數」那一欄的口徑。
 *
 * ⛔ 以 `userId` 去重：同一個人同一顆標籤在正常情況下只有一份文件
 * （doc id 是 `${userId}_${tagId}`），但這裡仍去重，不靠上游保證。
 */
export function memberCountsFromRows(rows: readonly UserTagRow[]): Record<string, number> {
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
 * 來源占比：這個帳號的標籤有多少是自動判出來的、多少是我們自己貼的。
 *
 * 這張卡回答的是「自動化程度」——幾乎全是 `manual` 就代表 AI 貼標其實沒在跑
 * （可能沒有標籤打開 AI 判斷，或判斷條件寫得太窄），而那件事目前沒有任何地方看得出來。
 */
export function aggregateSourceMix(rows: readonly UserTagRow[]): {
  counts: Record<UserTagSourceType, number>
  total: number
  customerExpressed: number
  ourOwn: number
} {
  const counts = { ai: 0, rule: 0, system: 0, manual: 0, import: 0 } as Record<UserTagSourceType, number>
  let total = 0
  let customerExpressed = 0
  for (const r of normalizeRows(rows)) {
    const src = r.sourceType
    if (!(src in counts)) continue // 未知來源不猜，直接不計（別讓髒資料灌進百分比）
    counts[src] += 1
    total += 1
    if (countsAsCustomerHit(src)) customerExpressed += 1
  }
  return { counts, total, customerExpressed, ourOwn: total - customerExpressed }
}

/**
 * 「客人自己表現出來的興趣」排行。
 *
 * ⛔ **只算 `countsAsCustomerHit` 為真的來源**，理由見 `shared/tag-admin.ts` 那支的註解：
 *   批次貼標與單人手動貼標在資料庫裡分不出來，把手動算進來的話，自己批次貼 300 人
 *   就會霸佔第一名而且濾不掉。
 * ⛔ `excludeTagIds` 一定要帶上「N 天沒互動」那顆系統標籤：它技術上算系統事件，
 *   但講的是「這個人沒有動作」不是興趣，量級又大，混進來會永遠佔第一名。
 */
export function rankCustomerExpressedTags(
  rows: readonly UserTagRow[],
  opts: { excludeTagIds?: readonly string[], limit?: number } = {},
): Array<{ tagId: string, users: number }> {
  const excluded = new Set(opts.excludeTagIds ?? [])
  const seen = new Map<string, Set<string>>()
  for (const r of normalizeRows(rows)) {
    if (!countsAsCustomerHit(r.sourceType)) continue
    if (excluded.has(r.tagId)) continue
    if (!seen.has(r.tagId)) seen.set(r.tagId, new Set())
    seen.get(r.tagId)!.add(r.userId)
  }
  const ranked = [...seen.entries()]
    .map(([tagId, users]) => ({ tagId, users: users.size }))
    // 同票數照 tagId 排，讓每次重算的順序穩定（畫面不要無故跳動）
    .sort((a, b) => b.users - a.users || a.tagId.localeCompare(b.tagId))
  return typeof opts.limit === 'number' ? ranked.slice(0, opts.limit) : ranked
}

/**
 * 標籤覆蓋率：有幾位客人身上至少有一顆標籤、有幾位一顆都沒有。
 *
 * ⛔ **分母誠信**：`totalUsers` 是好友名單裡的人數，而名單**只收得到互動過的人**
 *   （從沒講過話的好友根本不在庫裡）。畫面上一律寫「有互動的客人」，不可以寫「好友」，
 *   否則這個百分比是虛高的。
 * ⛔ `truncated`（掃描撞上限）時 `untaggedUsers` 與 `pct` 一律回 `null`：
 *   掃到一半的名單算出來的「沒有標籤的人數」是錯的，寧可講「算不出來」。
 */
export function aggregateCoverage(
  rows: readonly UserTagRow[],
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
 * 前幾大標籤的兩兩交集（`D-28` 想要、本份原稿漏掉的維度）。
 *
 * 例：「問過出貨」∩「買過東西」＝ 23 位，那是一群已經買了又在追進度的人。
 *
 * ⛔ **少於 `minUsers` 的組合不列**（`D-28` 誠實三規則之一，預設 5）：
 *   兩三個人的交集是雜訊，列出來只會讓人對著它腦補。
 * ⛔ 只吃傳進來的 `tagIds`（呼叫端給前 N 大），不要全表兩兩配——那是 O(n²) 顆標籤。
 */
export function topTagIntersections(
  rows: readonly UserTagRow[],
  opts: { tagIds: readonly string[], minUsers?: number, limit?: number },
): Array<{ a: string, b: string, users: number }> {
  const minUsers = opts.minUsers ?? 5
  const wanted = [...new Set(opts.tagIds)]
  const members = new Map<string, Set<string>>()
  for (const id of wanted) members.set(id, new Set())
  for (const r of normalizeRows(rows)) {
    const set = members.get(r.tagId)
    if (set) set.add(r.userId)
  }
  const out: Array<{ a: string, b: string, users: number }> = []
  for (let i = 0; i < wanted.length; i++) {
    for (let j = i + 1; j < wanted.length; j++) {
      const A = members.get(wanted[i]!)!
      const B = members.get(wanted[j]!)!
      // 小的那邊當迴圈基準，交集才不會白跑大集合
      const [small, big] = A.size <= B.size ? [A, B] : [B, A]
      let n = 0
      for (const u of small) if (big.has(u)) n++
      if (n >= minUsers) out.push({ a: wanted[i]!, b: wanted[j]!, users: n })
    }
  }
  out.sort((x, y) => y.users - x.users || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
  return typeof opts.limit === 'number' ? out.slice(0, opts.limit) : out
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
 * ⛔ 回傳的東西**不可以拿去跟收件匣的「待審 N 位」相加或對帳**：兩本帳問的問題不同，
 *   而且這本 2026-08-30 才開始記，更早的建議完全不在裡面。
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

/** 標籤健康檢查要用的最小標籤形狀 */
export interface TagLike {
  id: string
  name?: string
  status?: string
  aiMode?: string
}

/**
 * 事件紀錄 vs 意圖（`D-28` 誠實三規則之一：兩者在總結裡要分開講）。
 *
 * **為什麼非分不可**——2026-09-04 拿 MYFEEL 正式資料跑過才看出來的：
 * 那個帳號 2,433 筆貼標裡有 **2,369 筆（97.4%）是系統事件**（問卷填答、活動報名時自動貼的），
 * AI 從對話判出來的只有 63 筆、手動只有 1 筆。如果只照「來源」切成
 * 「客人自己表現的 vs 我們自己圈的」，畫面會顯示 **99.96% 對 0.04%**——
 * 數字漂亮但**沒有任何資訊量**，而且會讓人以為 AI 理解得很好，實際上 AI 只碰到 2.6%。
 *
 * 有意義的切法是**這顆標籤在回答什麼**：
 *  - 事件紀錄＝「這個人做過什麼」（填了哪份問卷、問過哪個商品）——名冊，本來就準
 *  - 意圖＝「這個人想要什麼」（在看咖啡機、問過價格優惠）——要 AI 讀對話才判得出來
 *
 * ⛔ 判斷依據用**標籤自己的 `aiMode`**（有沒有讓 AI 判），不是貼標來源：
 *   同一顆意圖標籤可能被 AI 貼、也可能被客服手動補，那仍然是同一種標籤。
 *   缺欄位＝off 是全系統口徑。
 */
export function splitEventVsIntent(
  rows: readonly UserTagRow[],
  tags: readonly TagLike[],
): {
  intent: { tags: number, taggings: number }
  event: { tags: number, taggings: number }
} {
  const intentTagIds = new Set(
    tags.filter(t => t?.id && (t.aiMode === 'suggest' || t.aiMode === 'auto')).map(t => t.id),
  )
  let intentTaggings = 0
  let eventTaggings = 0
  for (const r of normalizeRows(rows)) {
    if (intentTagIds.has(r.tagId)) intentTaggings++
    else eventTaggings++
  }
  const activeTags = tags.filter(t => t?.id && t.status !== 'inactive')
  return {
    intent: { tags: activeTags.filter(t => intentTagIds.has(t.id)).length, taggings: intentTaggings },
    event: { tags: activeTags.filter(t => !intentTagIds.has(t.id)).length, taggings: eventTaggings },
  }
}

/**
 * 標籤健康檢查：列出「建了沒用到」與「開著 AI 判斷卻從來沒判出人」的標籤。
 *
 * 為什麼要有：重複與殭屍標籤會讓上面每一張卡的數字失真（重複計數、稀釋排行）。
 *
 * ⛔ **只列出來建議，不自動刪不自動合併**：標籤貼在真人身上（`D-60` 的原則）。
 * ⛔ 「疑似重複」不在這裡做——`D-62` 已經有一套重複偵測，這裡只該指路過去，
 *   另做一套就是同一件事兩種答案。
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
