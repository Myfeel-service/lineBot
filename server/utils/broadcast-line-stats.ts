import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import { fetchBroadcastLineInsight } from '~~/server/utils/broadcast-line-insight'
import {
  LINE_STATS_MAX_AGE_DAYS,
  lineStatsDueRound,
  type StoredLineStats,
} from '~~/shared/broadcast-line-stats'

/**
 * 排程：把推播的 LINE 官方統計（打開的人、點連結的人）存進推播那一筆（`D-121`②）。
 *
 * 掛在 `/api/cron/run-tasks`（每 10 分鐘）。⛔ 不掛在發送那條路上：這件事晚幾分鐘無所謂，
 * 發送失敗卻是客人收不到訊息。
 *
 * - 只看最近 28 天送完的（再舊的 LINE 用現在的查法已經查不到）。
 * - 發完第 1、3、7 天各問一次；漏掉的輪次直接補到最新那一輪。
 * - **一輪最多問 LINE 6 次**：LINE 的統計查詢有次數上限，而且是跟推播成效頁共用的。
 *   排不到的下一輪接著做，回傳裡的 `deferred` 會講還剩幾則（⛔ 不靜靜丟掉）。
 * - 問失敗不推進輪次，6 小時後再試，失敗原因留在那一筆上。
 */

const DAY = 86_400_000
const SCAN_LIMIT = 500
const DEFAULT_MAX_CALLS = 6

function toMs(v: unknown): number | null {
  const d = (v as { toDate?: () => Date } | null | undefined)?.toDate?.()
  const ms = d?.getTime()
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : null
}

export async function snapshotBroadcastLineStats(
  db: Firestore,
  opts: { now?: number, maxCalls?: number } = {},
): Promise<{ scanned: number, due: number, calls: number, written: number, failed: number, deferred: number, truncated: boolean }> {
  const now = opts.now ?? Date.now()
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS

  // 單欄位範圍查詢（免複合索引），狀態在記憶體裡篩
  const snap = await db.collection('broadcasts')
    .where('completedAt', '>=', Timestamp.fromMillis(now - LINE_STATS_MAX_AGE_DAYS * DAY))
    .select('workspaceId', 'status', 'sentCount', 'startedAt', 'completedAt', 'lineAggregationUnit', 'lineInsightAggregationApplied', 'lineStats')
    .limit(SCAN_LIMIT + 1)
    .get()
  const docs = snap.docs.slice(0, SCAN_LIMIT)

  const due: { ref: FirebaseFirestore.DocumentReference, v: Record<string, any>, completedAt: number, round: number }[] = []
  for (const doc of docs) {
    const v = doc.data() as Record<string, any>
    if (v.status !== 'completed' && v.status !== 'failed') continue
    if (!(Number(v.sentCount) > 0)) continue
    const completedAt = toMs(v.completedAt)
    if (completedAt == null) continue
    const round = lineStatsDueRound(completedAt, now, v.lineStats as Partial<StoredLineStats> | undefined)
    if (round) due.push({ ref: doc.ref, v, completedAt, round })
  }
  // 最舊的先做：它最快就要查不到了
  due.sort((a, b) => a.completedAt - b.completedAt)

  let calls = 0
  let written = 0
  let failed = 0
  let handled = 0
  for (const d of due) {
    const prev = (d.v.lineStats ?? {}) as Partial<StoredLineStats>
    // 發送時就沒帶統計標記：永遠查不到，記一筆就不再問（不花 LINE 的查詢次數）
    if (d.v.lineInsightAggregationApplied === false) {
      const stored: StoredLineStats = { opened: null, clicked: null, round: 3, fetchedAt: now, unavailable: true }
      await d.ref.update({ lineStats: stored })
      written++
      handled++
      continue
    }
    if (calls >= maxCalls) break
    calls++
    handled++
    const r = await fetchBroadcastLineInsight(
      d.ref.id,
      String(d.v.workspaceId || '').trim(),
      d.v.lineAggregationUnit ?? null,
      toMs(d.v.startedAt) != null ? new Date(toMs(d.v.startedAt)!) : null,
      new Date(d.completedAt),
    )
    if (r.lineInsightError) {
      failed++
      const stored: StoredLineStats = {
        opened: prev.opened ?? null,
        clicked: prev.clicked ?? null,
        round: Number(prev.round ?? 0) || 0,
        fetchedAt: prev.fetchedAt ?? null,
        errorAt: now,
        error: String(r.lineInsightError).slice(0, 200),
      }
      await d.ref.update({ lineStats: stored })
      continue
    }
    const stored: StoredLineStats = {
      opened: r.lineUniqueImpression,
      clicked: r.lineUniqueClick,
      round: d.round,
      fetchedAt: now,
    }
    await d.ref.update({ lineStats: stored })
    written++
  }

  return {
    scanned: docs.length,
    due: due.length,
    calls,
    written,
    failed,
    deferred: due.length - handled,
    truncated: snap.size > SCAN_LIMIT,
  }
}
