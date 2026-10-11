import type { Firestore } from 'firebase-admin/firestore'
import { requireCapability } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { getStoreProfile } from '~~/server/utils/store-profile'
import { memberCountsForTagIds } from '~~/server/utils/tag-member-count'
import { INACTIVE_TAG_CODE } from '~~/server/utils/inactive-tag'
import { getMarketingSkips } from '~~/server/utils/marketing-skips'
import { matchAudienceTags, productKeywords, type AudienceTagLike } from '~~/shared/festival-audience'
import {
  broadcastFestivalMatch,
  buildFestivalOutcomes,
  findLastYearFestivalBroadcast,
  outcomeSummary,
  type BroadcastOutcome,
} from '~~/shared/festival-outcome'
import { parseStoredLineStats } from '~~/shared/broadcast-line-stats'
import {
  buildMarketingCalendar,
  calendarHeadline,
  type CalendarFacts,
  type PlannedBroadcast,
} from '~~/shared/marketing-calendar'
import { isStoreProfileReady } from '~~/shared/types/store-profile'
import { taipeiDate } from '~~/shared/time'
import { TAIWAN_FESTIVALS, type TaiwanFestival } from '~~/shared/taiwan-festivals'

/**
 * GET /api/marketing-calendar
 *
 * 未來 90 天的行銷月曆＋每一檔的建議卡（`D-85` / `C-224`）。
 *
 * ⛔ **每一句「為什麼」都要有出處**，所以這支要把真實數字撈出來餵給純函式：
 *    標籤人數、好友總數、去年同期發過的推播。拿不到的一律 `null`——
 *    ⛔ 不可以用 0 代替（0 位好友與「查不到好友數」是兩件事）。
 * ⚠️ 全部唯讀、全部單欄位等值查詢（免複合索引），每次呼叫約 3–4 次讀取。
 */

/**
 * ⚠️ **2026-09-23（`C-235`）把這裡原本那支 `tagMatchesFestival` 整個拿掉了**。
 *
 * 它跟 `draft.post.ts` 裡那支是同一條規則的**兩份拷貝**，而且兩份都是錯的：
 * 拿「送禮／禮盒／回購」去比對標籤名，在 MYFEEL 的 39 顆真標籤上**九個節日有八個一顆都挑不到**
 * ——店家的標籤是商品名與意圖，不是場合字。
 *
 * ⛔ 現在兩處都吃 `shared/festival-audience.ts` 的 `matchAudienceTags`，
 *   那裡有 20 條測試釘著。**不要在任何端點裡再長出第三份判斷**：
 *   同一件事兩種答案，正是這個專案踩過最多次的形狀。
 */

/** 掃描上限。撞到要回報，⛔ 不可以讓人把截斷後的數字當全部。 */
const BROADCAST_SCAN_LIMIT = 300

/** 還沒送完、可以算「已經為這一檔準備好」的狀態 */
const PLANNED_STATUSES = new Set(['draft', 'scheduled', 'processing', 'completed', 'failed'])

function toMs(v: unknown): number | null {
  const d = (v as { toDate?: () => Date } | null | undefined)?.toDate?.()
  const ms = d?.getTime()
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : null
}

/**
 * 把這個帳號的推播**掃一趟**撈回來，給「上一檔的回顧」「去年這一檔」「這一檔已經排了」三個用途共用
 * （08-11 讀取費暴衝的教訓：⛔ 不要每個節日各查一次）。
 *
 * ⚠️ **2026-09-23（`C-240`）修過兩個靜默無效**：狀態值是 `completed` 不是 `sent`、時間在 `completedAt` 不在 `sentAt`。
 * ⭐ **2026-10-11（`D-121`）不再掃點擊紀錄**：成效改讀推播那一筆上存好的 LINE 人數（`lineStats`），
 *   我們自己的點擊紀錄只數得出次數、而且 `C-301` 以前漏掉所有圖片上的連結。
 */
async function loadBroadcasts(
  db: Firestore,
  workspaceId: string,
): Promise<{ sent: BroadcastOutcome[], planned: (PlannedBroadcast & { festivalId?: string, matchAtMs: number | null })[], truncated: boolean, failed: boolean }> {
  try {
    // 單欄位等值查詢：⛔ 不加 orderBy 以免要複合索引
    const snap = await db.collection('broadcasts')
      .where('workspaceId', '==', workspaceId)
      .select('name', 'sentCount', 'completedAt', 'scheduleAt', 'createdAt', 'status', 'festivalId', 'lineStats')
      .limit(BROADCAST_SCAN_LIMIT + 1)
      .get()

    const sent: BroadcastOutcome[] = []
    const planned: (PlannedBroadcast & { festivalId?: string, matchAtMs: number | null })[] = []
    for (const doc of snap.docs.slice(0, BROADCAST_SCAN_LIMIT)) {
      const v = doc.data() as Record<string, unknown>
      const status = String(v.status ?? '')
      const name = String(v.name ?? '（沒有名稱）').slice(0, 40)
      const festivalId = v.festivalId ? String(v.festivalId) : undefined
      const completedAt = toMs(v.completedAt)
      const scheduleAt = toMs(v.scheduleAt)

      // ⛔ 只認真的送完的那些；`cancelled` 與還沒送的不算成效
      if ((status === 'completed' || status === 'failed') && completedAt != null) {
        sent.push({
          id: doc.id,
          name,
          atMs: completedAt,
          sentCount: Number(v.sentCount ?? 0),
          ...(festivalId ? { festivalId } : {}),
          line: parseStoredLineStats(v.lineStats),
        })
      }
      if (PLANNED_STATUSES.has(status)) {
        planned.push({
          id: doc.id,
          name,
          status: status as PlannedBroadcast['status'],
          atMs: status === 'scheduled' ? scheduleAt : (status === 'completed' || status === 'failed') ? completedAt : null,
          ...(festivalId ? { festivalId } : {}),
          // 名稱對節日時拿來比日期的時間：排程的看排程時間、發完的看發完時間、草稿看建立時間
          matchAtMs: scheduleAt ?? completedAt ?? toMs(v.createdAt),
        })
      }
    }
    return { sent, planned, truncated: snap.size > BROADCAST_SCAN_LIMIT, failed: false }
  }
  catch (e) {
    // ⛔ 查不到就回空＋`failed`（＝這幾條理由不出現），不可以編一個數字
    console.warn('[marketing-calendar] 推播掃描失敗：', workspaceId, e)
    return { sent: [], planned: [], truncated: false, failed: true }
  }
}

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireCapability(event, 'workspace.read')
  const db = getDb()
  const today = taipeiDate()

  const profile = await getStoreProfile(workspaceId, db)

  // ── 標籤與人數（一次撈完，逐檔在記憶體比對）──────────────────
  let tags: AudienceTagLike[] = []
  // ⛔ 用 code 反查不要寫死 id：「N 天沒互動」那顆是每個工作區各自建的
  let excludeTagIds: string[] = []
  try {
    const snap = await db.collection('tags')
      .where('workspaceId', '==', workspaceId)
      .where('status', '==', 'active')
      .limit(60)
      .get()
    tags = snap.docs.map((d) => {
      const v = d.data() as { name?: string, aiMode?: string }
      return { id: d.id, name: String(v.name ?? ''), aiMode: v.aiMode }
    })
    excludeTagIds = snap.docs
      .filter(d => (d.data() as { code?: string }).code === INACTIVE_TAG_CODE)
      .map(d => d.id)
  }
  catch { /* 查不到＝這一類理由不出現 */ }

  let counts: Record<string, number> = {}
  if (tags.length) {
    counts = await memberCountsForTagIds(db, workspaceId, tags.map(t => t.id)).catch(() => ({}))
  }

  // ⛔ 查不到要回 null 而不是 0：「0 位好友」與「查不到」是兩件事
  const friendCount = await db.collection('users')
    .where('workspaceId', '==', workspaceId)
    .count()
    .get()
    .then(s => s.data().count)
    .catch(() => null)

  // 推播掃一趟，給「去年這一檔」「上一檔的回顧」「這一檔已經排了」共用（⛔ 不要每個節日各查一次）
  const bc = await loadBroadcasts(db, workspaceId)
  // 他自己收起來的那幾檔（`C-236`）。查不到就當成沒收，⛔ 不要讓它擋住整張卡
  const skips = await getMarketingSkips(db, workspaceId).catch(() => ({}))

  // 輪廓裡的主打商品＝配對的主軸（`C-235`）。每一檔都是同一批詞，先算一次。
  const products = productKeywords(String(profile.fields?.products?.value ?? ''))

  const factsOf = (f: TaiwanFestival): CalendarFacts => {
    // `D-121`：去年這一檔「為它發的」推播，跟回顧同一條歸屬規則（⛔ 不再照日期猜）
    const ly = findLastYearFestivalBroadcast(f, TAIWAN_FESTIVALS, bc.sent)
    return {
      friendCount,
      matchedTags: matchAudienceTags(tags, counts, {
        festivalName: f.name,
        products,
        excludeTagIds,
      }).suggestions.map(s => ({ name: s.name, memberCount: s.users, why: s.reason })),
      lastYearBroadcast: ly ? { name: ly.name, sentCount: ly.sentCount, clicked: ly.line?.clicked ?? null } : null,
    }
  }

  // `D-121`：已經為這一檔建好的推播（從這裡擬的，或名稱裡有節日名的），卡片直接講排在哪天
  const plannedOf = (f: TaiwanFestival): PlannedBroadcast[] => bc.planned
    .filter(p => broadcastFestivalMatch({ name: p.name, atMs: p.matchAtMs, festivalId: p.festivalId }, f) !== null)
    .map(({ id, name, status, atMs }) => ({ id, name, status, atMs }))

  const entries = buildMarketingCalendar(today, profile, factsOf, undefined, plannedOf)
  const ready = isStoreProfileReady(profile)
  const outcomes = buildFestivalOutcomes(today, TAIWAN_FESTIVALS, bc.sent)
  const summary = outcomeSummary(outcomes, Date.now())
  return {
    today,
    ready,
    /**
     * ⭐ `C-235`：輪廓有沒有寫主打商品。**跟 `ready` 是兩件事**——
     * `isStoreProfileReady` 只要求答滿三題，但主打商品是下游全部都靠的那一格
     * （`tailorFestivalAngle` 沒有它就退回通用句、`matchAudienceTags` 沒有它就配不出受眾）。
     * ⛔ 不回這一欄的話，這張卡會安靜地一直不準。
     */
    hasProducts: products.length > 0,
    /**
     * `C-236`：他自己收起來的那幾檔。
     * ⛔ **後端不過濾**，整份月曆照樣回去，由畫面決定收在哪一列——
     *   後端濾掉的話「收起來的還原不回來」，那就變成靜靜消失了。
     */
    skippedFestivalIds: Object.keys(skips),
    headline: calendarHeadline(),
    entries,

    /**
     * ⭐ `C-55`②（`C-240`，2026-10-11 `D-121` 改版）：**上一檔做得怎麼樣**，收在卡片最下面一行。
     * 只算為節日發的推播、成效是 LINE 的人數；規則寫在 `shared/festival-outcome.ts` 檔頭。
     */
    outcomes,
    outcomeLabel: summary.label,
    outcomeLines: summary.lines,
    /** ⛔ 掃到上限或查不到要講出來，不可以讓人把殘缺的回顧當全部 */
    outcomeIntegrity: { truncated: bc.truncated, failed: bc.failed },
  }
})
