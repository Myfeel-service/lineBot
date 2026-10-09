import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { executeBroadcastSend } from './broadcast-send'
import { getDb } from './firebase'
import { parseFirestoreDate } from '~~/shared/firestore-date'
import { BROADCAST_ALL_RECIPIENTS_FAILED, BROADCAST_STUCK_SAFE_TO_RESEND, BROADCAST_STUCK_UNVERIFIED, humanizeBroadcastSendFailure } from '~~/shared/broadcast-failure'
/**
 * 排程到點送出也記一筆操作紀錄（`D-117` 拍板 1，2026-10-08）。
 * 以前紀錄停在「排定了推播」就斷了：看的人不知道後來到底有沒有送、送了幾人。
 * ⚠️ actor＝system、uid 空字串：送出那一刻沒有人在按，⛔ 不掛在「排程的那個人」頭上。
 * ⚠️ `writeAuditLog` 自己吞錯，記不進去也不影響送出結果。
 */
import { writeAuditLog } from './audit-log'

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

/** `claimBroadcastForSend` 認領不到時丟的錯：這一輪根本沒輪到它送（`broadcast-claim.ts`） */
const CLAIM_NOT_OURS_RE = /^(Cannot send broadcast with status|Broadcast not found|Broadcast scheduleAt is in the future|Scheduled broadcast missing scheduleAt)/

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
 * 再看 updatedAt：認領交易把 updatedAt 寫成跟 startedAt 同一個 serverTimestamp，
 * 之後的第一筆寫入（受眾快照，就在呼叫 LINE 前一步）才會推進它——
 *   updatedAt 仍等於 startedAt ＝ 連受眾快照都沒寫 ＝ 一定還沒呼叫 LINE，重發安全；
 *   其他所有情形（動過、讀不出來、缺欄位、比 startedAt 早）都當「無法確認」。
 * ⛔判不出來一律走保守側：說錯「沒人收到」會害人把整份名單重複轟炸一次
 * （2026-08-13 code review 抓到第一版把讀不出來的時間當成 0，剛好落在危險的那一側）。
 */
async function reapStuckProcessingBroadcasts(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
): Promise<number> {
  // processing 正常同時最多一兩筆；等值查詢走自動索引，時間門檻在記憶體比（免新複合索引）。
  // 只取判斷用得到的欄位：整份文件含 audienceSnapshot.resolvedUserIds（可能上千個 ID）與
  // messages 快照，而這裡一個都用不到——這支每分鐘跑一次，不能每次都把它們搬回來。
  const snap = await db.collection('broadcasts')
    .where('status', '==', 'processing')
    .select('workspaceId', 'name', 'startedAt', 'updatedAt')
    .limit(20)
    .get()
  if (snap.empty) return 0

  const now = Date.now()
  let reaped = 0

  for (const doc of snap.docs) {
    const data = doc.data()
    if (workspaceId && String(data.workspaceId || '') !== workspaceId) continue

    const startedAt = parseFirestoreDate(data.startedAt)
    const updatedAt = parseFirestoreDate(data.updatedAt)
    // 停滯時鐘取「最後一次有寫入的時間」，不是單看 startedAt：受眾很大時光解析名單就要幾分鐘，
    // 那筆快照寫入會把時鐘往前推，才不會把還在跑的發送誤判成卡死。
    const lastProgressMs = Math.max(startedAt?.getTime() ?? 0, updatedAt?.getTime() ?? 0)

    // 兩個時間都讀不出來：無從判斷跑多久了。這種文件不可能是剛認領的（認領交易一定寫兩個
    // serverTimestamp），放著不管會永遠卡在 processing，還一直占用上面 limit(20) 的名額，
    // 擋住真正該收殮的單 → 一律收殮，走保守文案。
    const judgeable = lastProgressMs > 0
    if (judgeable && now - lastProgressMs < STUCK_PROCESSING_MS) continue

    const lineNotCalled = Boolean(
      startedAt && updatedAt && updatedAt.getTime() === startedAt.getTime(),
    )

    try {
      const didReap = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref)
        if (fresh.data()?.status !== 'processing') return false
        tx.update(doc.ref, {
          status: 'failed',
          failureReason: lineNotCalled ? BROADCAST_STUCK_SAFE_TO_RESEND : BROADCAST_STUCK_UNVERIFIED,
          updatedAt: FieldValue.serverTimestamp(),
        })
        return true
      })
      if (!didReap) continue
      reaped++
      const stuckFor = judgeable ? `${Math.round((now - lastProgressMs) / 60_000)} 分鐘` : '時間不明'
      console.warn(
        `[broadcast-scheduler] 收殮卡死推播 ${doc.id}「${String(data.name || '')}」`
        + `（processing 已 ${stuckFor}，LINE 未呼叫=${lineNotCalled}）`,
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
 *
 * 兩種叫法（`G-104`①）：
 * - **不帶參數**＝排程器（Cron／trigger-scheduled，要密鑰），刻意處理全站
 * - **帶 `{ workspaceId }`**＝後台登入者（`/api/broadcast/process-due`），只處理那一個帳號。
 *   ⛔ 這條路的 workspaceId 是空的就擋：原本空字串會讓下面的 `if (workspaceId)` 過濾整個失效，
 *   超管沒帶帳號打 process-due 就變成幫全站發推播。
 */
export async function runDueScheduledBroadcasts(
  opts?: { workspaceId?: string },
): Promise<RunDueScheduledBroadcastsResponse> {
  const db = getDb()
  const now = Timestamp.now()
  const workspaceId = String(opts?.workspaceId || '').trim()
  if (opts && !workspaceId) {
    throw new Error('runDueScheduledBroadcasts: 帶了 opts 就要有 workspaceId（全站只給不帶參數的排程器）')
  }

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
    const docWorkspaceId = String(doc.data().workspaceId || '')
    const name = String(doc.data().name ?? '')
    try {
      const result = await executeBroadcastSend(id, { source: 'scheduler' })
      results.push({ id, success: result.success })
      console.log(`[broadcast-scheduler] ✓ ${id} sentCount=${result.sentCount}`)
      // ⛔ 每一位都沒送到時，推播本身是 `failed`——紀錄要跟它講同一件事、帶上原因（2026-10-10 審查抓到）
      await writeAuditLog({
        workspaceId: docWorkspaceId,
        uid: '',
        actor: 'system',
        action: 'broadcast.scheduledSend',
        targetId: id,
        after: {
          name,
          status: result.allFailed ? 'failed' : 'completed',
          totalCount: result.totalCount,
          sentCount: result.sentCount,
          failedCount: result.failedCount,
        },
        ...(result.allFailed
          ? { note: BROADCAST_ALL_RECIPIENTS_FAILED }
          : result.postSendError ? { note: `送出後記帳未完成：${result.postSendError}` } : {}),
      })
    }
    catch (e: unknown) {
      const error = String(e instanceof Error ? e.message : e)
      results.push({ id, success: false, error })
      console.error(`[broadcast-scheduler] ✗ ${id}`, error)
      // ⛔ 認領輸了（另一台排程器先拿走、剛被取消）不是「沒送出去」：那則可能正由別人送著，
      //    記一筆失敗會跟隨後那筆「送到 461 人」打架
      if (CLAIM_NOT_OURS_RE.test(error)) continue
      // 沒送出去也要留一筆：不然紀錄停在「排定了」，看的人會以為送了
      await writeAuditLog({
        workspaceId: docWorkspaceId,
        uid: '',
        actor: 'system',
        action: 'broadcast.scheduledSend',
        targetId: id,
        after: { name, status: 'failed' },
        note: humanizeBroadcastSendFailure(error),
      })
    }
  }

  return {
    triggered,
    results,
    reaped,
  }
}
