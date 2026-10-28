import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import { parseStoredLineStats } from '~~/shared/broadcast-line-stats'
import { parseFirestoreDate } from '~~/shared/firestore-date'
import {
  audienceComparable,
  pickPreviousSameAudience,
  type AudienceLike,
  type PreviousOpen,
} from '~~/shared/broadcast-open-compare'

/**
 * 往前看幾則：建立時間早於這則發完的最近幾則。一個帳號一天發不了幾則，30 則大約一兩個月。
 * 成效頁每打開一次就讀這麼多筆，⛔ 別放大（讀取費，見 `E-38`）。
 */
const PREVIOUS_SCAN_LIMIT = 30

/**
 * 成效頁「跟上一則發給同一群人的比」要的那一則（口徑見 shared/broadcast-open-compare.ts）。
 *
 * - 用現成的 broadcasts (workspaceId ASC, createdAt DESC) 索引，⛔ 不另開索引。
 *   條件是「建立時間早於這則發完」：比這則早發完的，一定也比這則發完早建立。
 * - 只讀比較要的欄位；`audienceSource` 只拿 type／tagIds／audienceId（匯入名單那一大串不讀）。
 * - 匯入名單沒有「同一群人」可言 → 一筆都不讀。
 */
export async function findPreviousSameAudienceOpen(
  db: Firestore,
  current: { id: string; workspaceId: string; audienceSource: AudienceLike; completedMs: number },
): Promise<PreviousOpen | null> {
  if (!audienceComparable(current.audienceSource)) return null

  const snap = await db.collection('broadcasts')
    .where('workspaceId', '==', current.workspaceId)
    .where('createdAt', '<', Timestamp.fromMillis(current.completedMs))
    .orderBy('createdAt', 'desc')
    .limit(PREVIOUS_SCAN_LIMIT)
    .select('name', 'status', 'audienceSource.type', 'audienceSource.tagIds', 'audienceSource.audienceId', 'sentCount', 'lineStats', 'completedAt')
    .get()

  const candidates = snap.docs.map((d) => {
    const v = d.data()
    return {
      id: d.id,
      name: String(v.name ?? ''),
      status: String(v.status ?? ''),
      audienceSource: (v.audienceSource ?? null) as AudienceLike,
      sentCount: Number(v.sentCount) || 0,
      opened: parseStoredLineStats(v.lineStats)?.opened ?? null,
      completedMs: parseFirestoreDate(v.completedAt)?.getTime() ?? null,
    }
  })
  return pickPreviousSameAudience(current, candidates)
}
