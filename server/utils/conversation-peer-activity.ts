import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore'

/**
 * 「這個工作區有沒有收過客人訊息」的單一來源。
 *
 * 開通就緒度（setup-status 的 firstMessageReceived）與開通引導的見證時刻
 * （onboarding/first-message）都吃這一支——兩邊口徑一旦分岔，就會出現
 * 「被拉去開通引導、引導自己一查卻說都做完了」那種自相矛盾的畫面。
 *
 * 判定欄位＝`lastPeerActivityAt`：只有客人真的傳了訊息才會寫它
 * （加好友的 customer_action 是 traceOnly，不會蓋這個欄位）。
 *
 * ⛔ 不可以退回「抓前 N 筆對話在記憶體找」的舊寫法：對話文件沒有排序時是照 doc id 排，
 * 跟「誰講過話」完全無關——2026-08-23 實測 320 場的鼴究室，前 20 筆只有 1 筆有值，
 * 再多幾場新對話就會翻成 0，於是一個天天在服務客人的帳號會被說成「還沒收過訊息」，
 * 每次進後台都被整頁拉去開通引導。這裡改用索引直接取「最近一次有客人講話」的那一場。
 */

/** 索引還沒建好時的保底掃描筆數（見下方 fallback 說明） */
const FALLBACK_SCAN_LIMIT = 20

function isMissingIndexError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e)
  return msg.includes('FAILED_PRECONDITION') || msg.includes('requires an index')
}

/**
 * 找出「最近一次有客人講話」的那場對話；從來沒有就回 null。
 *
 * 正常路徑＝複合索引 (workspaceId, lastPeerActivityAt desc) 直接取 1 筆：
 * 精準、而且只花 1 次讀取（舊寫法固定 20 次，還會答錯）。
 * 索引尚未部署時退回舊的掃描法——寧可回到「不精準但堪用」，也不要整項變成查不到。
 */
export async function findLatestPeerActiveConversation(
  db: Firestore,
  wid: string,
): Promise<QueryDocumentSnapshot | null> {
  const base = db.collection('conversations').where('workspaceId', '==', wid)
  try {
    const snap = await base.orderBy('lastPeerActivityAt', 'desc').limit(1).get()
    return snap.docs[0] ?? null
  }
  catch (e) {
    if (!isMissingIndexError(e))
      throw e
    console.warn('[setup] lastPeerActivityAt 索引還沒建好，暫時退回掃描前 20 筆')
    const snap = await base.limit(FALLBACK_SCAN_LIMIT).get()
    let latest: QueryDocumentSnapshot | null = null
    let latestMs = 0
    for (const doc of snap.docs) {
      const at = doc.data()?.lastPeerActivityAt
      const ms = typeof at?.toMillis === 'function' ? at.toMillis() : 0
      if (ms > latestMs) {
        latestMs = ms
        latest = doc
      }
    }
    return latest
  }
}

/** 曾收到任一則客人訊息 */
export async function hasReceivedPeerMessage(db: Firestore, wid: string): Promise<boolean> {
  return !!(await findLatestPeerActiveConversation(db, wid))
}
