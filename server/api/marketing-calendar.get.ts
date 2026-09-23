import type { Firestore } from 'firebase-admin/firestore'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { getStoreProfile } from '~~/server/utils/store-profile'
import { memberCountsForTagIds } from '~~/server/utils/tag-member-count'
import { INACTIVE_TAG_CODE } from '~~/server/utils/inactive-tag'
import { getMarketingSkips } from '~~/server/utils/marketing-skips'
import { matchAudienceTags, productKeywords, type AudienceTagLike } from '~~/shared/festival-audience'
import { buildFestivalOutcomes, outcomeHeadline, type BroadcastOutcome } from '~~/shared/festival-outcome'
import {
  buildMarketingCalendar,
  calendarHeadline,
  emptyCalendarFacts,
  type CalendarFacts,
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
const CLICK_SCAN_LIMIT = 5000

/**
 * 把這個帳號送出過的推播**掃一趟**撈回來（含各自的點擊次數）。
 *
 * ⚠️ **2026-09-23（`C-240`）修掉這裡兩個靜默無效**，正式資料上驗出來的：
 *   ① 原本查 `status == 'sent'`——但實際上的值是 **`completed`**（13 則）／`failed`／`cancelled`，
 *      **一則 `sent` 都沒有**，所以這個查詢永遠回空。
 *   ② 原本讀 `data.sentAt`——那個欄位**一則都沒有**，時間在 `completedAt`。
 *   兩個加起來，月曆卡那條「去年這個時候你發過 X」從上線到現在**一次都沒出現過**。
 *
 * ⚠️ 原本是**每個節日各查一次**（8 檔 × 200 筆＝1,600 次讀取）。改成掃一趟給所有用途共用
 *   （08-11 讀取費暴衝的教訓）。
 */
async function loadSentBroadcasts(
  db: Firestore,
  workspaceId: string,
): Promise<{ list: BroadcastOutcome[], truncated: boolean, failed: boolean }> {
  try {
    // 單欄位等值查詢：⛔ 不加 orderBy 以免要複合索引
    const snap = await db.collection('broadcasts')
      .where('workspaceId', '==', workspaceId)
      .select('name', 'sentCount', 'completedAt', 'status')
      .limit(BROADCAST_SCAN_LIMIT + 1)
      .get()

    const docs = snap.docs.slice(0, BROADCAST_SCAN_LIMIT)

    // 點擊次數：同樣掃一趟，在記憶體裡按 campaignId 分組
    // ⛔ 每筆的 userId 都是 null（multicast），所以這是「幾次」不是「幾個人」——
    //    口徑寫在 `shared/festival-outcome.ts` 的檔頭。
    const clicks: Record<string, number> = {}
    try {
      const clickSnap = await db.collection('broadcastClickLogs')
        .where('workspaceId', '==', workspaceId)
        .select('campaignId')
        .limit(CLICK_SCAN_LIMIT)
        .get()
      for (const d of clickSnap.docs) {
        const c = String((d.data() as { campaignId?: string }).campaignId ?? '')
        if (c) clicks[c] = (clicks[c] ?? 0) + 1
      }
    }
    catch { /* 點擊查不到＝點擊數當 0，但推播本身仍要列出來 */ }

    const list: BroadcastOutcome[] = []
    for (const doc of docs) {
      const v = doc.data() as { name?: string, sentCount?: number, completedAt?: { toDate?: () => Date }, status?: string, festivalId?: string }
      // ⛔ 只認真的送完的那些；`cancelled` 與還沒送的不算一檔
      if (v.status !== 'completed' && v.status !== 'failed') continue
      const at = v.completedAt?.toDate?.()
      if (!at || Number.isNaN(at.getTime())) continue
      list.push({
        id: doc.id,
        name: String(v.name ?? '（沒有名稱）').slice(0, 40),
        atMs: at.getTime(),
        sentCount: Number(v.sentCount ?? 0),
        clickCount: clicks[doc.id] ?? 0,
        // 有這一欄才敢講「這一檔的成績」；舊資料一律沒有，回顧那邊會退成「那段期間」
        ...(v.festivalId ? { festivalId: String(v.festivalId) } : {}),
      })
    }
    return { list, truncated: snap.size > BROADCAST_SCAN_LIMIT, failed: false }
  }
  catch (e) {
    // ⛔ 查不到就回空＋`failed`（＝這幾條理由不出現），不可以編一個數字
    console.warn('[marketing-calendar] 推播掃描失敗：', workspaceId, e)
    return { list: [], truncated: false, failed: true }
  }
}

/** 去年同一個節日前後 14 天內發過的推播（當「你去年做過」的證據）。 */
function findLastYearBroadcast(
  sent: readonly BroadcastOutcome[],
  f: TaiwanFestival,
): { name: string, sentCount: number } | null {
  const [y, m, d] = f.date.split('-').map(Number) as [number, number, number]
  if (!y || !m || !d) return null
  const center = Date.UTC(y - 1, m - 1, d)
  const half = 14 * 86_400_000
  const hit = sent.find(b => b.sentCount > 0 && Math.abs(b.atMs - center) <= half)
  return hit ? { name: hit.name, sentCount: hit.sentCount } : null
}

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireWorkspaceAccess(event, 'viewer')
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

  // 推播掃一趟，給「去年做過」與「上一檔的結果」共用（⛔ 不要每個節日各查一次）
  const sent = await loadSentBroadcasts(db, workspaceId)
  // 他自己收起來的那幾檔（`C-236`）。查不到就當成沒收，⛔ 不要讓它擋住整張卡
  const skips = await getMarketingSkips(db, workspaceId).catch(() => ({}))

  const skeleton = buildMarketingCalendar(today, profile, () => emptyCalendarFacts())
  const lastYear = new Map<string, { name: string, sentCount: number } | null>()
  for (const e of skeleton) {
    const f = { id: e.festivalId, date: e.date, name: e.name, angle: e.generalAngle } as TaiwanFestival
    lastYear.set(e.festivalId, findLastYearBroadcast(sent.list, f))
  }

  // 輪廓裡的主打商品＝配對的主軸（`C-235`）。每一檔都是同一批詞，先算一次。
  const products = productKeywords(String(profile.fields?.products?.value ?? ''))

  const factsOf = (f: TaiwanFestival): CalendarFacts => ({
    friendCount,
    matchedTags: matchAudienceTags(tags, counts, {
      festivalName: f.name,
      products,
      excludeTagIds,
    }).suggestions.map(s => ({ name: s.name, memberCount: s.users, why: s.reason })),
    lastYearBroadcast: lastYear.get(f.id) ?? null,
  })

  const entries = buildMarketingCalendar(today, profile, factsOf)
  const ready = isStoreProfileReady(profile)
  const outcomes = buildFestivalOutcomes(today, TAIWAN_FESTIVALS, sent.list)
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
    headline: calendarHeadline(entries, ready),
    entries,

    /**
     * ⭐ `C-55`②（`C-240`）：**上一檔做得怎麼樣**。沒有回顧的建議，第三個月就沒人看了。
     * ⛔ 口徑：`clickTotal` 是「連結被點幾次」不是「幾個人點」——multicast 的追蹤 token
     *   裡沒有 userId，細節寫在 `shared/festival-outcome.ts` 檔頭。
     */
    outcomes,
    outcomeHeadline: outcomeHeadline(outcomes),
    /** ⛔ 掃到上限或查不到要講出來，不可以讓人把殘缺的回顧當全部 */
    outcomeIntegrity: { truncated: sent.truncated, failed: sent.failed },
  }
})
