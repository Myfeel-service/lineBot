import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { executeBroadcastSend } from './broadcast-send'
import { getDb } from './firebase'

export type DueScheduledBroadcastResult = {
  id: string
  success: boolean
  error?: string
}

export type RunDueScheduledBroadcastsResponse = {
  triggered: number
  results: DueScheduledBroadcastResult[]
  /** 仍為 scheduled 但 scheduleAt 尚未到期（除錯用） */
  pendingFuture?: number
  /** 本輪被看門狗收殮成 failed 的卡死推播數 */
  reaped?: number
}

/**
 * processing 超過這麼久還沒有結果＝發送流程已經死了。
 * 正常發送（含 3000+ 人的 multicast 分批）都在幾十秒內結束，Lambda 本身最多也只能跑分鐘級；
 * 10 分鐘是「絕不誤殺活單」的保守值。
 */
const STUCK_PROCESSING_MS = 10 * 60_000

/**
 * 看門狗：把卡死在 processing 的推播收殮成 failed，讓它重新有出口。
 *
 * 為什麼需要：發送流程若在「認領之後、結果落地之前」被硬殺（Lambda 凍結／進程死亡），
 * 單子會永遠停在 processing——排程器只撿 scheduled、取消只收 draft/scheduled、
 * 手動發送視 processing 為終態，小幫手的兩顆推播警示也都看不到它（2026-08-12 AROMIC預熱事故）。
 * 收殮成 failed 之後：小幫手既有的「推播發送失敗」警示會亮、後台可用「重設為草稿」重發。
 *
 * 能否安全補發的判定：checkpoint 設計是 LINE 一回應就立刻落地結果並蓋掉 processing，
 * 所以還停在 processing 的單，最遠只可能走到「LINE 已呼叫但 checkpoint 沒寫」那一小段。
 * 再看 updatedAt：認領交易把 updatedAt 寫成跟 startedAt 同一刻，之後的第一筆寫入（受眾快照）
 * 才會推進它——updatedAt 沒動過＝連受眾快照都沒寫＝一定還沒呼叫 LINE，重發安全；
 * updatedAt 動過＝死在快照之後，無法確認 LINE 收下了沒，重發可能重複，要人工確認。
 */
async function reapStuckProcessingBroadcasts(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
): Promise<number> {
  // processing 正常同時最多一兩筆；等值查詢走自動索引，時間門檻在記憶體比（免新複合索引）
  const snap = await db.collection('broadcasts')
    .where('status', '==', 'processing')
    .limit(20)
    .get()
  if (snap.empty) return 0

  const now = Date.now()
  let reaped = 0

  for (const doc of snap.docs) {
    const data = doc.data()
    if (workspaceId && String(data.workspaceId || '') !== workspaceId) continue

    const startedMs = (data.startedAt as Timestamp | undefined)?.toMillis?.() ?? 0
    if (!startedMs || now - startedMs < STUCK_PROCESSING_MS) continue

    const updatedMs = (data.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0
    const lineNotCalled = updatedMs <= startedMs

    try {
      const didReap = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref)
        if (fresh.data()?.status !== 'processing') return false
        tx.update(doc.ref, {
          status: 'failed',
          failureReason: lineNotCalled
            ? '發送在開始後中斷，還沒送到 LINE 就停了——沒有任何人收到，可以放心重發。'
            : '發送做到一半中斷，無法確認 LINE 是否已把訊息送出。重發前請先跟一兩位名單上的客人確認有沒有收到，避免重複發送。',
          updatedAt: FieldValue.serverTimestamp(),
        })
        return true
      })
      if (!didReap) continue
      reaped++
      console.warn(
        `[broadcast-scheduler] 收殮卡死推播 ${doc.id}「${String(data.name || '')}」`
        + `（processing 已 ${Math.round((now - startedMs) / 60_000)} 分鐘，LINE 未呼叫=${lineNotCalled}）`,
      )
    }
    catch (e) {
      console.error(`[broadcast-scheduler] 收殮 ${doc.id} 失敗`, e)
    }
  }

  return reaped
}

/**
 * 查詢 status=scheduled 且 scheduleAt <= 現在 的推播並發送；
 * 順路收殮卡死在 processing 的單（看門狗）。
 * 由 POST /api/broadcast/trigger-scheduled 與應用內建 Cron 共用。
 */
export async function runDueScheduledBroadcasts(
  opts?: { workspaceId?: string },
): Promise<RunDueScheduledBroadcastsResponse> {
  const db = getDb()
  const now = Timestamp.now()
  const workspaceId = String(opts?.workspaceId || '').trim()

  // 看門狗先跑：到期佇列空的時候（最常見）也要能收殮
  const reaped = await reapStuckProcessingBroadcasts(db, workspaceId).catch((e) => {
    console.error('[broadcast-scheduler] 看門狗查詢失敗', e)
    return 0
  })

  const snap = await db.collection('broadcasts')
    .where('status', '==', 'scheduled')
    .where('scheduleAt', '<=', now)
    .orderBy('scheduleAt', 'asc')
    .limit(20)
    .get()

  if (snap.empty) {
    let pendingFuture: number | undefined
    try {
      const pendingSnap = await db.collection('broadcasts')
        .where('status', '==', 'scheduled')
        .limit(1)
        .get()
      if (!pendingSnap.empty) {
        const futureSnap = await db.collection('broadcasts')
          .where('status', '==', 'scheduled')
          .where('scheduleAt', '>', now)
          .limit(1)
          .get()
        if (!futureSnap.empty) pendingFuture = 1
      }
    }
    catch {
      /* 略過除錯查詢 */
    }
    return { triggered: 0, results: [], pendingFuture, reaped }
  }

  console.log(`[broadcast-scheduler] 找到 ${snap.docs.length} 個到期排程推播`)

  const results: DueScheduledBroadcastResult[] = []
  let triggered = 0

  for (const doc of snap.docs) {
    if (workspaceId && String(doc.data().workspaceId || '') !== workspaceId) continue

    triggered++
    const id = doc.id
    try {
      const result = await executeBroadcastSend(id, { source: 'scheduler' })
      results.push({ id, success: result.success })
      console.log(`[broadcast-scheduler] ✓ ${id} sentCount=${result.sentCount}`)
    }
    catch (e: unknown) {
      const error = String(e instanceof Error ? e.message : e)
      results.push({ id, success: false, error })
      console.error(`[broadcast-scheduler] ✗ ${id}`, error)
    }
  }

  return {
    triggered,
    results,
    reaped,
  }
}
