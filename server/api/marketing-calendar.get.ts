import type { Firestore } from 'firebase-admin/firestore'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { getStoreProfile } from '~~/server/utils/store-profile'
import { memberCountsForTagIds } from '~~/server/utils/tag-member-count'
import { INACTIVE_TAG_CODE } from '~~/server/utils/inactive-tag'
import { matchAudienceTags, productKeywords, type AudienceTagLike } from '~~/shared/festival-audience'
import {
  buildMarketingCalendar,
  calendarHeadline,
  emptyCalendarFacts,
  type CalendarFacts,
} from '~~/shared/marketing-calendar'
import { isStoreProfileReady } from '~~/shared/types/store-profile'
import { taipeiDate } from '~~/shared/time'
import type { TaiwanFestival } from '~~/shared/taiwan-festivals'

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

/** 去年同一個節日前後 14 天內發過的推播（只取一筆，當「你去年做過」的證據）。 */
async function findLastYearBroadcast(
  db: Firestore,
  workspaceId: string,
  f: TaiwanFestival,
): Promise<{ name: string, sentCount: number } | null> {
  try {
    const [y, m, d] = f.date.split('-').map(Number) as [number, number, number]
    const center = Date.UTC(y - 1, m - 1, d)
    const from = new Date(center - 14 * 86_400_000)
    const to = new Date(center + 14 * 86_400_000)
    // 單欄位等值查詢＋記憶體過濾：⛔ 不加 orderBy(sentAt) 以免要複合索引
    const snap = await db.collection('broadcasts')
      .where('workspaceId', '==', workspaceId)
      .where('status', '==', 'sent')
      .limit(200)
      .get()
    for (const doc of snap.docs) {
      const data = doc.data() as { name?: string, sentCount?: number, sentAt?: { toDate?: () => Date } }
      const at = data.sentAt?.toDate?.()
      if (!at || at < from || at > to) continue
      const sentCount = Number(data.sentCount ?? 0)
      if (sentCount <= 0) continue
      return { name: String(data.name ?? '（沒有名稱）').slice(0, 40), sentCount }
    }
    return null
  }
  catch {
    // ⛔ 查不到就回 null（＝這一條理由不出現），不可以編一個數字
    return null
  }
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

  // 先算出視窗內有哪幾個節日，才知道要為哪幾個查推播（⛔ 不要為 17 個節日都查）
  const skeleton = buildMarketingCalendar(today, profile, () => emptyCalendarFacts())
  const lastYear = new Map<string, { name: string, sentCount: number } | null>()
  for (const e of skeleton) {
    const f = { id: e.festivalId, date: e.date, name: e.name, angle: e.generalAngle } as TaiwanFestival
    lastYear.set(e.festivalId, await findLastYearBroadcast(db, workspaceId, f))
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
    headline: calendarHeadline(entries, ready),
    entries,
  }
})
