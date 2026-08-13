/**
 * 推播發送失敗時給人看的說明（`broadcasts.failureReason`）——所有寫入端共用這裡的措辭。
 *
 * 為什麼收成一份：這幾句話直接決定操作的人「要不要按重發」。
 * 小幫手的 broadcastFailed 警示已經對外承諾「進去看失敗原因，處理後可以重新發送」，
 * 所以每一條把 status 寫成 failed 的路徑都必須留下一句人看得懂的原因，
 * 不能只有看門狗那條有寫（2026-08-13 code review 抓到）。
 */

/** 看門狗：卡死在發送中，且確定還沒呼叫 LINE（認領後沒有第二筆寫入） */
export const BROADCAST_STUCK_SAFE_TO_RESEND
  = '發送在開始後中斷，還沒送到 LINE 就停了——沒有任何人收到，可以放心重發。'

/**
 * 看門狗：卡死在發送中，但已經寫過受眾快照＝無法確定 LINE 收下了沒。
 * ⛔這句是保守側的預設：只要時間戳判讀不出來（欄位缺失、非 Timestamp 形狀），
 * 一律走這句，不可以退回「沒有任何人收到」——那會害人重複轟炸整份名單。
 */
export const BROADCAST_STUCK_UNVERIFIED
  = '發送做到一半中斷，無法確認 LINE 是否已把訊息送出。重發前請先跟一兩位名單上的客人確認有沒有收到，避免重複發送。'

/** LINE 收下了訊息，但回報每一位收件人都送不到 */
export const BROADCAST_ALL_RECIPIENTS_FAILED
  = 'LINE 回報名單上每一位都沒收到，多半是這些人已經封鎖或刪除官方帳號。重發前建議先確認名單。'

/**
 * 把發送流程內部的錯誤訊息換成操作的人看得懂的一句話。
 * 認得的照字面翻；認不得的保留原文當線索（工程要查得到），但前面先講清楚「還沒送出」。
 */
export function humanizeBroadcastSendFailure(rawReason: string): string {
  const reason = String(rawReason || '').trim()

  if (/Resolved audience is empty/i.test(reason)) {
    return '發送對象算出來是 0 人（標籤沒有人、或名單上的人都已封鎖官方帳號），沒有送出任何訊息。改好發送對象後可以重發。'
  }
  if (/No valid LINE user IDs in audience/i.test(reason)) {
    return '名單上的人都沒有可用的 LINE 帳號識別碼，沒有送出任何訊息。請確認名單來源後重發。'
  }
  if (/No messages to send/i.test(reason)) {
    return '這則推播沒有訊息內容，沒有送出任何訊息。補上內容後可以重發。'
  }
  if (/Broadcast module not found or empty/i.test(reason)) {
    return '這則推播要送的機器人模組已經被刪掉或內容是空的，沒有送出任何訊息。重新選一個模組後可以重發。'
  }
  if (/Audience not found/i.test(reason)) {
    return '這則推播指定的受眾名單已經不存在，沒有送出任何訊息。重新選擇發送對象後可以重發。'
  }
  if (/Broadcast missing workspaceId/i.test(reason)) {
    return '這則推播的資料不完整（缺少所屬官方帳號），沒有送出任何訊息。請重新建立一則。'
  }

  return `發送沒有完成，還沒送出任何訊息（系統訊息：${reason || '未知錯誤'}）。可以重發試試；一直失敗請把這句話一起回報。`
}
