import { requireCapability } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { getStoreProfile } from '~~/server/utils/store-profile'
import { memberCountsForTagIds } from '~~/server/utils/tag-member-count'
import { INACTIVE_TAG_CODE } from '~~/server/utils/inactive-tag'
import { getMarketingSkips } from '~~/server/utils/marketing-skips'
import { getMarketingEvents } from '~~/server/utils/marketing-events'
import { loadCalendarBroadcasts } from '~~/server/utils/marketing-calendar-broadcasts'
import { matchAudienceTags, productKeywords, type AudienceTagLike } from '~~/shared/festival-audience'
import {
  buildFestivalOutcomes,
  findLastYearFestivalBroadcast,
  outcomeSummary,
} from '~~/shared/festival-outcome'
import {
  buildMarketingCalendar,
  calendarHeadline,
  plannedForFestival,
  type CalendarFacts,
  type PlannedBroadcast,
} from '~~/shared/marketing-calendar'
import { ownEventFestival, type MarketingEvent } from '~~/shared/marketing-events'
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

/*
 * 推播掃一趟的那支（`loadCalendarBroadcasts`）2026-10-19（`D-122`）搬到 `server/utils/marketing-calendar-broadcasts.ts`：
 * 早上的 LINE 提醒也要知道「這一檔排了沒」，⛔ 兩邊各寫一份就會一邊說排好了、一邊叫他去排。
 */

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
  const bc = await loadCalendarBroadcasts(db, workspaceId)
  // 他自己收起來的那幾檔（`C-236`）。查不到就當成沒收，⛔ 不要讓它擋住整張卡
  const skips = await getMarketingSkips(db, workspaceId).catch(() => ({}))
  /**
   * 店家自己的檔期（`D-122`②）。⛔ 查不到要講出來（`ownEventsFailed`）：
   * 靜靜少了他親手加的那幾檔，他會以為加了沒存到。
   */
  let ownEventsFailed = false
  const ownEvents: MarketingEvent[] = await getMarketingEvents(db, workspaceId).catch((e) => {
    console.warn('[marketing-calendar] 自己的檔期讀不到：', workspaceId, e)
    ownEventsFailed = true
    return []
  })
  const ownFestivals = ownEvents.map(ownEventFestival)

  // 輪廓裡的主打商品＝配對的主軸（`C-235`）。每一檔都是同一批詞，先算一次。
  const products = productKeywords(String(profile.fields?.products?.value ?? ''))

  const factsOf = (f: TaiwanFestival): CalendarFacts => {
    // `D-121`：去年這一檔「為它發的」推播，跟回顧同一條歸屬規則（⛔ 不再照日期猜）。
    // 自己的檔期沒有「去年這一檔」：名字是他今年取的，去年同一天不一定是同一件事
    const ly = f.own ? null : findLastYearFestivalBroadcast(f, TAIWAN_FESTIVALS, bc.sent)
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

  // `D-121`：已經為這一檔建好的推播（從這裡擬的，或名稱裡有節日名的），卡片直接講排在哪天。
  // ⛔ 跟早上的 LINE 提醒同一支（`plannedForFestival`）
  const plannedOf = (f: TaiwanFestival): PlannedBroadcast[] => plannedForFestival(bc.planned, f)

  const entries = buildMarketingCalendar(today, profile, factsOf, undefined, plannedOf, ownFestivals)
  const ready = isStoreProfileReady(profile)
  // `D-122`②：回顧也算自己的檔期（發完看得到幾個人打開、點連結）
  const outcomes = buildFestivalOutcomes(today, [...TAIWAN_FESTIVALS, ...ownFestivals], bc.sent)
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
    /** `D-122`②：自己的檔期讀不到。卡片要講「讀不到你加的檔期」，⛔ 不可以當成一檔都沒加 */
    ownEventsFailed,
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
