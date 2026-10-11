/**
 * 推播發完後存下來的 LINE 官方統計（`D-121`②，2026-10-11）。
 *
 * ── 為什麼要自己存 ─────────────────────────────────────────────
 * 推播成效頁原本每次都現場問 LINE，但用現在的查法**只查得到大約一個月內**的推播
 * （2026-10-11 實測：8 月那幾則全回錯誤）。首頁「接下來的檔期」要回看 90 天，
 * 而且首頁每打開一次就問 LINE 好幾次也太浪費——所以由排程在發完第 1、3、7 天各抓一次，
 * 存進推播那一筆（`broadcasts/{id}.lineStats`），首頁卡與成效頁都讀這一份。
 *
 * ── 口徑 ──────────────────────────────────────────────────────
 * - `opened`＝打開的人數、`clicked`＝點了訊息裡任一個連結的人數，**都是人數**（LINE 自己去重過）。
 *   ⛔ 跟我們自己的點擊紀錄（`broadcastClickLogs`，次數、而且 `C-301` 以前漏掉圖片上的連結）是兩回事。
 * - 人數少於 20 時 LINE 基於隱私回空值 → 存 `null`，畫面講「人太少，LINE 不提供」，⛔ 不寫 0。
 */
/** 給畫面用的 LINE 官方統計。人數少於 20 時 LINE 基於隱私回空值，所以每一格都可能是 null。 */
export interface BroadcastLineStats {
  /** 打開這則推播的人數 */
  opened: number | null
  /** 點了訊息裡任一個連結的人數 */
  clicked: number | null
  /** 這則發送時沒帶到 LINE 的統計標記（`lineInsightAggregationApplied === false`），永遠查不到 */
  unavailable?: boolean
}

/** 存在 `broadcasts/{id}.lineStats` 的樣子。時間一律毫秒。 */
export interface StoredLineStats {
  opened: number | null
  clicked: number | null
  /** 第幾輪抓到的（1＝發完第 1 天、2＝第 3 天、3＝第 7 天，之後不再變）。0＝還沒成功抓到過 */
  round: number
  fetchedAt: number | null
  /** 這則發送時沒帶到 LINE 的統計標記，永遠查不到（不用再問） */
  unavailable?: boolean
  /** 最近一次問 LINE 失敗的時間與原因（失敗不推進輪次，6 小時後再試） */
  errorAt?: number | null
  error?: string | null
}

/** 發完第幾天各抓一次 */
export const LINE_STATS_ROUND_DAYS = [1, 3, 7] as const
/** 超過這麼多天就不再問（LINE 用現在的查法已經查不到） */
export const LINE_STATS_MAX_AGE_DAYS = 28
/** 問失敗後隔多久再試 */
export const LINE_STATS_RETRY_MS = 6 * 60 * 60 * 1000

const DAY = 86_400_000

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 讀推播文件上的 `lineStats`。還沒成功抓到過＝null（畫面講「還沒拿到」）。 */
export function parseStoredLineStats(raw: unknown): BroadcastLineStats | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Partial<StoredLineStats>
  if (s.unavailable === true) return { opened: null, clicked: null, unavailable: true }
  if (!(Number(s.round) >= 1)) return null
  return { opened: numOrNull(s.opened), clicked: numOrNull(s.clicked) }
}

/**
 * 這則推播現在該不該去問 LINE、問完算第幾輪。不用問＝null。
 *
 * ⭐ 漏掉的輪次直接跳到最新該有的那一輪（例：發完第 10 天才第一次輪到它 → 直接算第 3 輪），
 *   所以功能上線當下、一個月內的舊推播各問一次就補齊。
 */
export function lineStatsDueRound(
  completedAtMs: number,
  nowMs: number,
  stored: Partial<StoredLineStats> | null | undefined,
): number | null {
  if (!Number.isFinite(completedAtMs)) return null
  const age = nowMs - completedAtMs
  if (age < LINE_STATS_ROUND_DAYS[0] * DAY || age > LINE_STATS_MAX_AGE_DAYS * DAY) return null
  if (stored?.unavailable) return null
  if (stored?.errorAt && nowMs - stored.errorAt < LINE_STATS_RETRY_MS) return null
  let target = 0
  LINE_STATS_ROUND_DAYS.forEach((d, i) => { if (age >= d * DAY) target = i + 1 })
  const current = Number(stored?.round ?? 0) || 0
  return target > current ? target : null
}
