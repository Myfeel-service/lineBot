import { FieldPath, FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { fetchBroadcastLineInsight } from '~~/server/utils/broadcast-line-insight'
import { parseFirestoreDate } from '~~/shared/firestore-date'
import {
  LINE_STATS_MAX_AGE_DAYS,
  lineStatsDueRound,
  lineStatsNextDueAt,
  type StoredLineStats,
} from '~~/shared/broadcast-line-stats'

/**
 * 排程：把推播的 LINE 官方統計（打開的人、點連結的人）存進推播那一筆（`D-121`②）。
 *
 * 掛在 `/api/cron/run-tasks`（每 10 分鐘）。⛔ 不掛在發送那條路上：這件事晚幾分鐘無所謂，
 * 發送失敗卻是客人收不到訊息。
 *
 * - 發完第 1、3、7 天各問一次；漏掉的輪次直接補到最新那一輪。超過 28 天就不再問（LINE 查不到了）。
 * - **一輪最多問 LINE 6 次**：LINE 的統計查詢有次數上限，而且是跟推播成效頁共用的。
 *   排不到的下一輪接著做，回傳裡的 `deferred` 會講還剩幾則（⛔ 不靜靜丟掉）。
 * - 問失敗不推進輪次，6 小時後再試，失敗原因留在那一筆上。
 *
 * ── 怎麼找到該問的那幾則（2026-10-12 審查改寫）─────────────────────
 * 原本每一輪把最近 28 天送完的推播**整批讀回來**（不排序、上限 501 筆）再在記憶體裡挑：
 *   ① 幾乎全是已經問完的，卻每 10 分鐘讀一次（一個月 200 則＝一天約 28,800 次讀取）；
 *   ② 有範圍條件時 Firestore 由舊到新回，28 天內超過 500 則時，最新的那些永遠排不到。
 * 現在每一則推播上記著**下一次該問的時間** `lineStatsNextAt`（毫秒，`lineStatsNextDueAt` 算）：
 *   - 發完那一刻由發送那支寫上（`broadcast-send.ts`：發完 1 天後）；
 *   - 這裡每處理一則就改成下一輪的時間；三輪問完、確定問不到、已經沒事可做的**整欄拿掉**，
 *     之後連讀都讀不到它；
 *   - 這裡只查「`lineStatsNextAt` ≤ 現在」、照時間由早到晚、一次最多 20 筆
 *     → 平常是一個空查詢；到期最久的先做（它最快就要查不到了），做過的一定往後移或離開隊伍，
 *       所以不會有一批舊的永遠占著名額。
 *   單一欄位的範圍＋同一欄位排序，Firestore 自動建的單欄位索引就夠，⛔ 不需要新的複合索引。
 *
 * ── 上線前就發完的推播（沒有 `lineStatsNextAt`）────────────────────
 * Firestore 查不出「沒有這一欄的」，所以另外補一趟 `stampLegacyBroadcasts`，⛔ 不用手動回填：
 *   - 照完成時間由舊到新、一輪最多 200 筆，把 28 天內還有輪次要問的補上 `lineStatsNextAt`，
 *     進度（游標）記在 `cronState/broadcast-line-stats-legacy`，下一輪從停的地方接著補；
 *   - 掃到最新那一則**而且**從第一次跑起已經過了 1 小時，就記 `doneAt`。多等 1 小時是給部署那一刻
 *     還在舊版程式裡發送的推播（發完時沒有寫上這一欄）；
 *   - 記了 `doneAt` 之後每一輪只讀那一份標記（1 次讀取，跟推播有幾則無關），⛔ 不再掃推播。
 *   部署之後發完的推播都由發送那支寫上這一欄，所以補完一趟就不會再有漏網的。
 */

const DAY = 86_400_000
/** 一輪最多讀幾則到期的。比 LINE 次數多一些：確定問不到、已經過期的不用問 LINE，可以一起清掉 */
const DUE_SCAN_LIMIT = 20
const DEFAULT_MAX_CALLS = 6

const LEGACY_STATE_DOC = 'broadcast-line-stats-legacy'
const DEFAULT_LEGACY_PAGE = 200
/** 補標記至少要跑這麼久才算做完：部署那一刻還在發送中的推播（舊版程式）可能晚幾分鐘才發完 */
const LEGACY_GRACE_MS = 60 * 60 * 1000

/** 只有真的送出去、而且送到人的推播才有 LINE 人數可問 */
function isSnapshotEligible(v: Record<string, any>): boolean {
  return (v.status === 'completed' || v.status === 'failed') && Number(v.sentCount) > 0
}

/** Firestore 時間欄位 → 毫秒。走全站共用的 `parseFirestoreDate`（⛔ 不在這裡再寫一份） */
function toMs(v: unknown): number | null {
  return parseFirestoreDate(v)?.getTime() ?? null
}

interface LegacyState {
  startedAt?: number
  cursor?: { at: unknown, id: string } | null
  doneAt?: number
}

/**
 * 上線前就發完、沒有 `lineStatsNextAt` 的推播：補上去（只補一趟，見檔頭）。
 * 冪等：已經有這一欄的、做完的、沒送到人的一律跳過；重跑只會補到還沒補的。
 */
async function stampLegacyBroadcasts(
  db: Firestore,
  now: number,
  pageSize: number,
): Promise<{ scanned: number, stamped: number, done: boolean }> {
  const stateRef = db.collection('cronState').doc(LEGACY_STATE_DOC)
  const state = ((await stateRef.get()).data() ?? {}) as LegacyState
  if (state.doneAt) return { scanned: 0, stamped: 0, done: true }

  const startedAt = typeof state.startedAt === 'number' ? state.startedAt : now
  const lowerMs = now - LINE_STATS_MAX_AGE_DAYS * DAY
  // 完成時間＋文件 id 排序：同一個完成時間的好幾則跨在兩輪之間也不會漏（單欄位索引就夠）
  let q = db.collection('broadcasts')
    .where('completedAt', '>=', Timestamp.fromMillis(lowerMs))
    .orderBy('completedAt')
    .orderBy(FieldPath.documentId())
  const cursor = state.cursor
  const cursorMs = cursor ? toMs(cursor.at) : null
  // 游標已經掉出 28 天外＝它之前的都過期了，從 28 天前重新開始就好
  if (cursor && cursorMs != null && cursorMs >= lowerMs) q = q.startAfter(cursor.at, cursor.id)
  const snap = await q
    .select('status', 'sentCount', 'completedAt', 'lineStats', 'lineStatsNextAt')
    .limit(pageSize)
    .get()

  let stamped = 0
  for (const doc of snap.docs) {
    const v = doc.data() as Record<string, any>
    if (v.lineStatsNextAt != null || !isSnapshotEligible(v)) continue
    const next = lineStatsNextDueAt(toMs(v.completedAt), v.lineStats as Partial<StoredLineStats> | undefined)
    if (next == null) continue
    await doc.ref.update({ lineStatsNextAt: next })
    stamped++
  }

  const last = snap.docs[snap.docs.length - 1]
  const done = snap.size < pageSize && now - startedAt >= LEGACY_GRACE_MS
  await stateRef.set({
    startedAt,
    cursor: last ? { at: last.get('completedAt'), id: last.id } : (cursor ?? null),
    lastRunAt: now,
    ...(done ? { doneAt: now } : {}),
  }, { merge: true })
  return { scanned: snap.size, stamped, done }
}

export async function snapshotBroadcastLineStats(
  db: Firestore,
  opts: { now?: number, maxCalls?: number, legacyPageSize?: number } = {},
): Promise<{
  scanned: number
  due: number
  calls: number
  written: number
  failed: number
  deferred: number
  rescheduled: number
  dropped: number
  truncated: boolean
  legacy: { scanned: number, stamped: number, done: boolean, error?: string }
}> {
  const now = opts.now ?? Date.now()
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS

  // 先補舊推播的標記，補上的這一輪就排得進下面的隊伍。⛔ 補標記壞掉不可以擋住正常的那條路
  let legacy: { scanned: number, stamped: number, done: boolean, error?: string }
  try {
    legacy = await stampLegacyBroadcasts(db, now, opts.legacyPageSize ?? DEFAULT_LEGACY_PAGE)
  }
  catch (e) {
    console.warn('[broadcast-line-stats] 補舊推播的標記失敗：', e)
    legacy = { scanned: 0, stamped: 0, done: false, error: String((e as Error)?.message ?? e).slice(0, 200) }
  }

  const snap = await db.collection('broadcasts')
    .where('lineStatsNextAt', '<=', now)
    .orderBy('lineStatsNextAt')
    .select('workspaceId', 'status', 'sentCount', 'startedAt', 'completedAt', 'lineAggregationUnit', 'lineInsightAggregationApplied', 'lineStats', 'lineStatsNextAt')
    .limit(DUE_SCAN_LIMIT + 1)
    .get()
  const docs = snap.docs.slice(0, DUE_SCAN_LIMIT)

  let due = 0
  let calls = 0
  let written = 0
  let failed = 0
  let deferred = 0
  let rescheduled = 0
  let dropped = 0
  for (const doc of docs) {
    const v = doc.data() as Record<string, any>
    const prev = (v.lineStats ?? {}) as Partial<StoredLineStats>
    const completedAt = toMs(v.completedAt)

    // 重設成草稿、沒送到人、完成時間讀不出來：這一則沒有東西可問。拿掉就好——重設再發時發送那支會重新寫上
    if (!isSnapshotEligible(v) || completedAt == null) {
      await doc.ref.update({ lineStatsNextAt: FieldValue.delete() })
      dropped++
      continue
    }
    // 發送時就沒帶統計標記：永遠查不到，記一筆就不再問（不花 LINE 的查詢次數）
    if (v.lineInsightAggregationApplied === false) {
      const stored: StoredLineStats = { opened: null, clicked: null, round: 3, fetchedAt: now, unavailable: true }
      await doc.ref.update({ lineStats: stored, lineStatsNextAt: FieldValue.delete() })
      written++
      continue
    }
    const round = lineStatsDueRound(completedAt, now, prev)
    if (!round) {
      // 被排進來但現在不該問：時間還沒到（改成正確的時間）或已經過期、問完了（拿掉）
      const next = lineStatsNextDueAt(completedAt, prev)
      if (next != null && next > now) {
        await doc.ref.update({ lineStatsNextAt: next })
        rescheduled++
      }
      else {
        await doc.ref.update({ lineStatsNextAt: FieldValue.delete() })
        dropped++
      }
      continue
    }

    due++
    // 次數用完：不動它，它的時間最早，下一輪排第一個
    if (calls >= maxCalls) {
      deferred++
      continue
    }
    calls++
    const startedAt = toMs(v.startedAt)
    const r = await fetchBroadcastLineInsight(
      doc.ref.id,
      String(v.workspaceId || '').trim(),
      v.lineAggregationUnit ?? null,
      startedAt != null ? new Date(startedAt) : null,
      new Date(completedAt),
    )
    const stored: StoredLineStats = r.lineInsightError
      ? {
          opened: prev.opened ?? null,
          clicked: prev.clicked ?? null,
          round: Number(prev.round ?? 0) || 0,
          fetchedAt: prev.fetchedAt ?? null,
          errorAt: now,
          error: String(r.lineInsightError).slice(0, 200),
        }
      : { opened: r.lineUniqueImpression, clicked: r.lineUniqueClick, round, fetchedAt: now }
    // 下一輪的時間（失敗＝6 小時後；三輪問完或再等就超過 28 天＝拿掉）
    const next = lineStatsNextDueAt(completedAt, stored)
    await doc.ref.update({ lineStats: stored, lineStatsNextAt: next ?? FieldValue.delete() })
    if (r.lineInsightError) failed++
    else written++
  }

  return {
    scanned: docs.length,
    due,
    calls,
    written,
    failed,
    deferred,
    rescheduled,
    dropped,
    // 到期的比一輪讀得多：下一輪接著做（⛔ 不靜靜丟掉）
    truncated: snap.size > DUE_SCAN_LIMIT,
    legacy,
  }
}
