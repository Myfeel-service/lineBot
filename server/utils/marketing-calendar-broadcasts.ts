/**
 * 「接下來的檔期」要用的推播，掃一趟撈回來（`D-121`；2026-10-19 `D-122` 從 `marketing-calendar.get.ts` 搬出來）。
 *
 * ⭐ **卡片與早上的 LINE 提醒吃同一支**（`D-122`①）：卡片說「✓ 已排程 10/16 20:00」、
 *   LINE 卻叫他「今天就去排」，就是兩邊各自判斷「這一檔排了沒」的下場。
 *   歸屬規則在 `shared/marketing-calendar.ts` 的 `plannedForFestival`（再往下是 `festival-outcome.ts`）。
 *
 * ⚠️ **2026-09-23（`C-240`）修過兩個靜默無效**：狀態值是 `completed` 不是 `sent`、時間在 `completedAt` 不在 `sentAt`。
 * ⭐ **2026-10-11（`D-121`）不再掃點擊紀錄**：成效改讀推播那一筆上存好的 LINE 人數（`lineStats`）。
 */
import type { Firestore } from 'firebase-admin/firestore'
import type { BroadcastOutcome } from '~~/shared/festival-outcome'
import type { CalendarBroadcastRow, PlannedBroadcast } from '~~/shared/marketing-calendar'
import { parseStoredLineStats } from '~~/shared/broadcast-line-stats'
import { parseFirestoreDate } from '~~/shared/firestore-date'

/** 掃描上限。撞到要回報，⛔ 不可以讓人把截斷後的數字當全部。 */
export const CALENDAR_BROADCAST_SCAN_LIMIT = 300

/** 還沒送完、可以算「已經為這一檔準備好」的狀態 */
const PLANNED_STATUSES = new Set(['draft', 'scheduled', 'processing', 'completed', 'failed'])

/** Firestore 時間欄位 → 毫秒。走全站共用的 `parseFirestoreDate`（⛔ 不在這裡再寫一份） */
function toMs(v: unknown): number | null {
  return parseFirestoreDate(v)?.getTime() ?? null
}

export interface CalendarBroadcasts {
  /** 真的送完的（回顧與「去年這一檔」用） */
  sent: BroadcastOutcome[]
  /** 草稿、排程、發送中、發完、失敗（「這一檔已經排了」用） */
  planned: CalendarBroadcastRow[]
  truncated: boolean
  failed: boolean
}

/**
 * 把這個帳號的推播**掃一趟**撈回來，給「上一檔的回顧」「去年這一檔」「這一檔已經排了」共用
 * （08-11 讀取費暴衝的教訓：⛔ 不要每個節日各查一次）。
 *
 * ⛔ 查不到就回空＋`failed`，不可以編一個數字。
 */
export async function loadCalendarBroadcasts(db: Firestore, workspaceId: string): Promise<CalendarBroadcasts> {
  try {
    // 單欄位等值查詢：⛔ 不加 orderBy 以免要複合索引
    const snap = await db.collection('broadcasts')
      .where('workspaceId', '==', workspaceId)
      .select('name', 'sentCount', 'completedAt', 'scheduleAt', 'createdAt', 'status', 'festivalId', 'lineStats')
      .limit(CALENDAR_BROADCAST_SCAN_LIMIT + 1)
      .get()

    const sent: BroadcastOutcome[] = []
    const planned: CalendarBroadcastRow[] = []
    for (const doc of snap.docs.slice(0, CALENDAR_BROADCAST_SCAN_LIMIT)) {
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
          matchAtMs: scheduleAt ?? completedAt ?? toMs(v.createdAt),
        })
      }
    }
    return { sent, planned, truncated: snap.size > CALENDAR_BROADCAST_SCAN_LIMIT, failed: false }
  }
  catch (e) {
    console.warn('[marketing-calendar] 推播掃描失敗：', workspaceId, e)
    return { sent: [], planned: [], truncated: false, failed: true }
  }
}
