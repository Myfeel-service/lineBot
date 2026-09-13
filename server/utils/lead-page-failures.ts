import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import type { Firestore } from 'firebase-admin/firestore'
import {
  LEAD_FAILURE_REASONS,
  LEAD_TIMEOUT_STAGES,
  type LeadFailureReason,
  type LeadTimeoutStage,
} from '~~/shared/lead-page-failure'

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
 *
 * 同時併出兩個 2026-09-13 才有的東西：
 * · `succeeded`＝同一段時間**順利完成**幾次。⭐ 沒有它，「117 次沒完成」單獨掛在畫面上
 *   看起來像整個活動壞了，實際上同期有 812 人順利完成（`G-90`）。
 * · `byTimeoutStage`＝逾時卡在哪一步。舊桶沒有這格，會全部落在 `unknown`——
 *   ⛔ 那是「還沒開始記」不是「查不出來」，畫面若要用必須講清楚。
 */
export function sumFailureBuckets(
  buckets: Array<{ counts?: Record<string, unknown>, stages?: Record<string, unknown>, okCount?: unknown }>,
): {
  byReason: Record<LeadFailureReason, number>
  total: number
  unknownReasons: string[]
  succeeded: number
  byTimeoutStage: Record<LeadTimeoutStage, number>
  unknownStages: string[]
} {
  const byReason = Object.fromEntries(
    LEAD_FAILURE_REASONS.map(r => [r, 0]),
  ) as Record<LeadFailureReason, number>
  const byTimeoutStage = Object.fromEntries(
    LEAD_TIMEOUT_STAGES.map(s => [s, 0]),
  ) as Record<LeadTimeoutStage, number>
  const unknown = new Set<string>()
  const unknownStage = new Set<string>()
  let total = 0
  let succeeded = 0

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

    for (const [stage, raw] of Object.entries(b.stages ?? {})) {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) continue
      if ((LEAD_TIMEOUT_STAGES as readonly string[]).includes(stage))
        byTimeoutStage[stage as LeadTimeoutStage] += n
      else
        unknownStage.add(stage)
    }

    const ok = Number(b.okCount)
    if (Number.isFinite(ok) && ok > 0) succeeded += ok
  }
  return {
    byReason,
    total,
    unknownReasons: [...unknown],
    succeeded,
    byTimeoutStage,
    unknownStages: [...unknownStage],
  }
}

/** 記一次失敗（同一小時同一租戶併成一份文件，counts 逐項 increment） */
export async function recordLeadPageFailure(
  db: Firestore,
  input: {
    workspaceId: string
    reason: LeadFailureReason
    campaignCode?: string
    detail?: string
    /** 逾時卡在哪一步。⛔ 只有 `load_timeout` 有意義，其他原因傳了也不記 */
    stage?: LeadTimeoutStage
  },
): Promise<void> {
  const now = new Date()
  const bucketStartAt = hourBucketStart(now)
  const docId = failureBucketDocId(input.workspaceId, hourBucketKey(now))

  // ⛔ 階段要**逐項累加**，不能只靠 lastDetail：一個桶只留得住最後一筆細節，
  //    2026-09-13 查那 94 次逾時時整批只看得到同一句話，等於沒記（`G-88`）。
  const stage = input.reason === 'load_timeout' ? input.stage : undefined

  await db.collection(LEAD_PAGE_FAILURES_COLLECTION).doc(docId).set({
    workspaceId: input.workspaceId,
    bucketStartAt,
    expireAt: Timestamp.fromMillis(now.getTime() + RETENTION_DAYS * 86_400_000),
    counts: { [input.reason]: FieldValue.increment(1) },
    ...(stage ? { stages: { [stage]: FieldValue.increment(1) } } : {}),
    // 最後一筆的細節：夠用來認出是同一種壞法，⛔ 不留完整訊息（客人的網址可能帶參數）
    lastReason: input.reason,
    lastCampaignCode: String(input.campaignCode || '').slice(0, 64),
    lastDetail: String(input.detail || '').slice(0, 200),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
}

/**
 * 記一次**成功**（跟失敗放同一份桶文件）。
 *
 * 為什麼要記、而且要記在這裡：後台原本只看得到失敗次數，「近 7 天 117 次打不開」
 * 旁邊沒有分母，看起來像整個活動壞掉——實際上同期有 812 人順利完成（2026-09-13）。
 * 放同一份文件是為了**不用另外開索引**：讀失敗的那支查詢原封不動就一起撈到了。
 *
 * ⛔ 這一支只能由**伺服器**在綁定成功後呼叫。失敗那支沒辦法驗身分（見檔頭），
 * 拿得到公開連結的人可以灌高失敗數；分母要是也能從外面灌，比例就完全沒有意義了。
 */
export async function recordLeadPageSuccess(db: Firestore, workspaceId: string): Promise<void> {
  const wid = String(workspaceId || '').trim()
  if (!wid) return

  const now = new Date()
  await db.collection(LEAD_PAGE_FAILURES_COLLECTION)
    .doc(failureBucketDocId(wid, hourBucketKey(now)))
    .set({
      workspaceId: wid,
      bucketStartAt: hourBucketStart(now),
      expireAt: Timestamp.fromMillis(now.getTime() + RETENTION_DAYS * 86_400_000),
      okCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
}

/** 讀近 N 天的失敗計數（以及同期成功次數＝分母） */
export async function readLeadPageFailures(
  db: Firestore,
  workspaceId: string,
  sinceMs: number,
): Promise<{
  byReason: Record<LeadFailureReason, number>
  total: number
  unknownReasons: string[]
  /** 同一段時間順利完成幾次。⛔ 沒有它就不要把失敗次數點成紅燈——沒有分母的數字嚇人而已 */
  succeeded: number
  /** 逾時卡在哪一步（工程用，後台不顯示） */
  byTimeoutStage: Record<LeadTimeoutStage, number>
  unknownStages: string[]
  /** 桶數撞到掃描上限＝數字偏低，畫面要說出來（⛔ 不可以靜靜少算） */
  truncated: boolean
}> {
  const snap = await db.collection(LEAD_PAGE_FAILURES_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('bucketStartAt', '>=', new Date(sinceMs))
    .orderBy('bucketStartAt', 'desc')
    .limit(LEAD_FAILURE_BUCKET_SCAN_LIMIT)
    .get()

  const summed = sumFailureBuckets(snap.docs.map(d => d.data() as {
    counts?: Record<string, unknown>
    stages?: Record<string, unknown>
    okCount?: unknown
  }))
  return { ...summed, truncated: snap.size >= LEAD_FAILURE_BUCKET_SCAN_LIMIT }
}
