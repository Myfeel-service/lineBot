import type { Firestore } from 'firebase-admin/firestore'
import { requireWorkspaceAccess } from '~~/server/utils/workspace-auth'
import { getDb } from '~~/server/utils/firebase'
import { getStoreProfile } from '~~/server/utils/store-profile'
import { memberCountsForTagIds } from '~~/server/utils/tag-member-count'
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

/** 哪些標籤名看起來跟「這個節日」有關。⛔ 純字面比對，不猜、不打 LLM。 */
function tagMatchesFestival(tagName: string, f: TaiwanFestival): boolean {
  const n = tagName.toLowerCase()
  if (n.includes(f.name.toLowerCase())) return true
  // 送禮類節日 → 「送禮」「禮盒」相關的標籤
  if (/春節|中秋|除夕|聖誕|情人|母親節|父親節/.test(f.name) && /送禮|禮盒|贈禮/.test(tagName)) return true
  // 折扣類 → 「回購」「揪團」「囤貨」
  if (/雙 ?11|購物節/.test(f.name) && /回購|囤貨|揪團|優惠/.test(tagName)) return true
  return false
}

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
  let tags: { id: string, name: string }[] = []
  try {
    const snap = await db.collection('tags')
      .where('workspaceId', '==', workspaceId)
      .where('status', '==', 'active')
      .limit(60)
      .get()
    tags = snap.docs.map(d => ({ id: d.id, name: String((d.data() as { name?: string }).name ?? '') }))
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

  const factsOf = (f: TaiwanFestival): CalendarFacts => ({
    friendCount,
    matchedTags: tags
      .filter(t => tagMatchesFestival(t.name, f))
      .map(t => ({ name: t.name, memberCount: counts[t.id] ?? 0 }))
      .filter(t => t.memberCount > 0),
    lastYearBroadcast: lastYear.get(f.id) ?? null,
  })

  const entries = buildMarketingCalendar(today, profile, factsOf)
  const ready = isStoreProfileReady(profile)
  return {
    today,
    ready,
    headline: calendarHeadline(entries, ready),
    entries,
  }
})
