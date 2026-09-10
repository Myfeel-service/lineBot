import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import type { Firestore } from 'firebase-admin/firestore'
import { LEAD_FAILURE_REASONS, type LeadFailureReason } from '~~/shared/lead-page-failure'

/**
 * 活動頁（LIFF）在客人手上失敗的計數。
 *
 * 為什麼要有這個：在此之前，客人打不開活動頁**沒有任何一條路會讓後台知道**。
 * 唯一的偵測是後台主動去 LINE 對 Endpoint URL 有沒有寫對——只要失敗原因不是那個
 * （連結被轉傳截斷、LIFF 被停用、客人環境問題），後台就是一片綠燈而客人一個都進不來。
 * 同一款沉默死亡已經發生過三次（見記憶 `feedback_filters_must_report_what_they_dropped`）。
 *
 * ⚠️ **這是訊號，不是報表**：回報端點沒有辦法驗證身分（失敗的當下客人連 LIFF token
 * 都拿不到），所以數字可能被拿到公開連結的人灌水。畫面上要講「幾次」不要講「幾位客人」，
 * 用途是「該去看一下設定了」，不是拿來算轉換率。
 *
 * 一小時一個桶：7 天最多 168 份文件，讀的時候一次撈完即可（⛔ 不用 offset 分頁，
 * 見 2026-08-11 讀取費暴衝）。
 */
export const LEAD_PAGE_FAILURES_COLLECTION = 'leadPageFailures'

/** 保留 30 天，靠 `expireAt` ＋ TTL policy 自動清（欄位名沿用站內慣例，⛔ 不要寫成 expiresAt） */
const RETENTION_DAYS = 30

/** 一次最多讀幾個桶：7 天 × 24 小時＝168，取 200 留餘裕；超過要回報 truncated 不可靜靜截斷 */
export const LEAD_FAILURE_BUCKET_SCAN_LIMIT = 200

/** UTC 整點桶鍵（純函式）。用 UTC 是因為它只當分組鍵，換時區不該讓同一小時裂成兩桶。 */
export function hourBucketKey(at: Date): string {
  const iso = at.toISOString() // 2026-09-10T07:23:45.000Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}`
}

/** 桶的起始時刻（純函式）：桶鍵反解回 Date，供範圍查詢與畫面顯示 */
export function hourBucketStart(at: Date): Date {
  const d = new Date(at.getTime())
  d.setUTCMinutes(0, 0, 0)
  return d
}

/** 文件 ID（純函式）。⛔ workspaceId 可能含 `/`（Firestore 不允許），一律換掉。 */
export function failureBucketDocId(workspaceId: string, bucketKey: string): string {
  return `${String(workspaceId).replace(/[/\s]/g, '_')}__${bucketKey}`
}

/**
 * 把各桶的 counts 併成「每種原因幾次」（純函式，方便測）。
 * ⛔ 只認識 `LEAD_FAILURE_REASONS` 裡的代碼；不認識的要回在 `unknownReasons`
 * 而不是丟掉——舊版寫進去的代碼消失在畫面上，就是另一種沉默死亡。
 */
export function sumFailureBuckets(
  buckets: Array<{ counts?: Record<string, unknown> }>,
): { byReason: Record<LeadFailureReason, number>, total: number, unknownReasons: string[] } {
  const byReason = Object.fromEntries(
    LEAD_FAILURE_REASONS.map(r => [r, 0]),
  ) as Record<LeadFailureReason, number>
  const unknown = new Set<string>()
  let total = 0

  for (const b of buckets) {
    for (const [reason, raw] of Object.entries(b.counts ?? {})) {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) continue
      if ((LEAD_FAILURE_REASONS as readonly string[]).includes(reason)) {
        byReason[reason as LeadFailureReason] += n
      }
      else {
        unknown.add(reason)
      }
      total += n
    }
  }
  return { byReason, total, unknownReasons: [...unknown] }
}

/** 記一次失敗（同一小時同一租戶併成一份文件，counts 逐項 increment） */
export async function recordLeadPageFailure(
  db: Firestore,
  input: { workspaceId: string, reason: LeadFailureReason, campaignCode?: string, detail?: string },
): Promise<void> {
  const now = new Date()
  const bucketStartAt = hourBucketStart(now)
  const docId = failureBucketDocId(input.workspaceId, hourBucketKey(now))

  await db.collection(LEAD_PAGE_FAILURES_COLLECTION).doc(docId).set({
    workspaceId: input.workspaceId,
    bucketStartAt,
    expireAt: Timestamp.fromMillis(now.getTime() + RETENTION_DAYS * 86_400_000),
    counts: { [input.reason]: FieldValue.increment(1) },
    // 最後一筆的細節：夠用來認出是同一種壞法，⛔ 不留完整訊息（客人的網址可能帶參數）
    lastReason: input.reason,
    lastCampaignCode: String(input.campaignCode || '').slice(0, 64),
    lastDetail: String(input.detail || '').slice(0, 200),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
}

/** 讀近 N 天的失敗計數 */
export async function readLeadPageFailures(
  db: Firestore,
  workspaceId: string,
  sinceMs: number,
): Promise<{
  byReason: Record<LeadFailureReason, number>
  total: number
  unknownReasons: string[]
  /** 桶數撞到掃描上限＝數字偏低，畫面要說出來（⛔ 不可以靜靜少算） */
  truncated: boolean
}> {
  const snap = await db.collection(LEAD_PAGE_FAILURES_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('bucketStartAt', '>=', new Date(sinceMs))
    .orderBy('bucketStartAt', 'desc')
    .limit(LEAD_FAILURE_BUCKET_SCAN_LIMIT)
    .get()

  const summed = sumFailureBuckets(snap.docs.map(d => d.data() as { counts?: Record<string, unknown> }))
  return { ...summed, truncated: snap.size >= LEAD_FAILURE_BUCKET_SCAN_LIMIT }
}
