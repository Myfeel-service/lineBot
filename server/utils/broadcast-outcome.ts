import { v4 as uuidv4 } from 'uuid'
import { FieldValue } from 'firebase-admin/firestore'
import { lineStatsNextDueAt } from '~~/shared/broadcast-line-stats'
import { BROADCAST_ALL_RECIPIENTS_FAILED } from '~~/shared/broadcast-failure'
import type { BroadcastDeliveryDoc } from '~~/shared/types/tag-broadcast'

/**
 * 推播發送結果的寫法（從 broadcast-send.ts 抽出來，`D-154`②③）。
 * 群發／一人一則在 broadcast-send.ts 當場寫，narrowcast 在 broadcast-narrowcast.ts 等 LINE 送完才寫——
 * ⛔ 兩邊都用這一支，欄位才不會各寫一套而漂掉。
 */

/** LINE 已回應後才會有：代表「訊息確實已經送出」 */
export type BroadcastLineOutcome = {
  successCount: number
  failedCount: number
  allFailed: boolean
  aggregationUnit: string | null
  aggregationApplied: boolean
  /** 一人一則送時整批停下來的原因（本月額度用完這種）／narrowcast 送失敗的原因，每一位都沒送到時拿來當失敗原因 */
  stoppedReason?: string | null
}

/** 發送結果的唯一寫法：checkpoint／最終／catch／narrowcast 送完都由此產生 */
export function broadcastOutcomePatch(o: BroadcastLineOutcome) {
  return {
    status: o.allFailed ? 'failed' as const : 'completed' as const,
    sentCount: o.successCount,
    failedCount: o.failedCount,
    completedAt: FieldValue.serverTimestamp(),
    lineAggregationUnit: o.aggregationUnit,
    lineInsightAggregationApplied: o.aggregationApplied,
    // 每一條寫 failed 的路徑都要留下人看得懂的原因（小幫手警示已承諾「進去看失敗原因」）；
    // 成功時明確清成 null，才不會留著上一輪嘗試的舊原因
    // ⚠️ 一人一則送到一半整批停下來（額度用完）時講那個原因，⛔ 不要說成「多半是封鎖了」
    failureReason: o.allFailed ? (o.stoppedReason || BROADCAST_ALL_RECIPIENTS_FAILED) : null,
    /**
     * `D-121`：排上「發完第 1 天去問 LINE 的打開／點連結人數」。排程只讀這個時間到了的推播
     * （`server/utils/broadcast-line-stats.ts`），⛔ 少了這一欄這則就永遠不會被問到。
     * 一個人都沒送到的沒有人數可問，不排。
     */
    lineStatsNextAt: o.successCount > 0 ? lineStatsNextDueAt(Date.now(), null) : FieldValue.delete(),
  }
}

/**
 * 只記「沒收到的人」到 deliveries。
 * 成功者不逐筆記錄：受眾名單已存在 audienceSnapshot，成功＝名單減掉失敗名單，
 * 且 LINE 的「成功」只代表它收下訊息、不代表客人看到（那是報表的開封數）。
 * 全員送達時一筆都不寫，直接消掉了 3000＋人推播最容易逾時的一步。
 * 回傳 postSendError（寫失敗＝訊息已送出、只是名單沒記完；null＝沒事）。
 */
export async function writeFailedDeliveries(
  db: FirebaseFirestore.Firestore,
  campaignId: string,
  failedRecipients: Array<{ docId: string; lineUserId: string }>,
  failureReasons: Record<string, string> = {},
): Promise<string | null> {
  if (!failedRecipients.length) return null
  try {
    const BATCH_LIMIT = 400
    let batch = db.batch()
    let opsInBatch = 0
    const flushBatch = async () => {
      if (opsInBatch > 0) {
        await batch.commit()
        batch = db.batch()
        opsInBatch = 0
      }
    }
    const createdAt = FieldValue.serverTimestamp()
    for (const r of failedRecipients) {
      const deliveryDoc: BroadcastDeliveryDoc = {
        campaignId,
        userId: r.docId,
        deliveryStatus: 'failed',
        // 群發是一批最多 500 人一起回覆結果，拿不到每個人各自的原因；一人一則有
        failureReason: failureReasons[r.lineUserId] ?? 'LINE multicast failed',
        sentAt: null,
        createdAt,
      }
      batch.set(db.collection('broadcasts').doc(campaignId).collection('deliveries').doc(uuidv4()), deliveryDoc)
      opsInBatch++
      if (opsInBatch >= BATCH_LIMIT) await flushBatch()
    }
    await flushBatch()
    return null
  }
  catch (e) {
    console.error('[broadcast/send] 失敗名單寫入失敗（訊息已送出，不影響推播結果）:', e)
    return `沒收到的名單未寫完：${e instanceof Error ? e.message : String(e)}`
  }
}
