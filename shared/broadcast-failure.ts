/**
 * 推播發送失敗時給人看的說明（`broadcasts.failureReason`）——所有寫入端共用這裡的措辭。
 *
 * 為什麼收成一份：這幾句話直接決定操作的人「要不要按重發」。
 * 小幫手的 broadcastFailed 警示已經對外承諾「進去看失敗原因，處理後可以重新發送」，
 * 所以每一條把 status 寫成 failed 的路徑都必須留下一句人看得懂的原因，
 * 不能只有看門狗那條有寫（2026-08-13 code review 抓到）。
 */
import { broadcastLockText } from './billing/plans'

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

/**
 * 看門狗：一人一則送的推播（`sendMode: 'perRecipient'`，`D-118` A）做到一半中斷。
 * 每一位帶固定的重送編號，LINE 24 小時內認得——同一則推播再送一次，收過的人會被擋下來。
 * ⚠️ 兩個條件都要講：超過 24 小時 LINE 就不認了；內容改過的話 LINE 不保證擋得住。
 */
export const BROADCAST_STUCK_PER_RECIPIENT
  = '發送做到一半中斷，有些人已經收到、有些人還沒。這則是一人一則送的：24 小時內按「重設為草稿再發一次」、內容不要改，已經收到的人不會收到第二則，只會補送給還沒收到的人。超過 24 小時再發就可能重複。'

/** LINE 收下了訊息，但回報每一位收件人都送不到 */
export const BROADCAST_ALL_RECIPIENTS_FAILED
  = 'LINE 回報名單上每一位都沒收到，多半是這些人已經封鎖或刪除官方帳號。重發前建議先確認名單。'

/**
 * 把發送流程內部的錯誤訊息換成操作的人看得懂的一句話。
 * 認得的照字面翻；認不得的保留原文當線索（工程要查得到），但前面先講清楚「還沒送出」。
 */
export function humanizeBroadcastSendFailure(rawReason: string): string {
  const reason = String(rawReason || '').trim()

  // 方案不含這種推播（`D-131`）：原因本身就是推播頁鎖住時那一句，照原句講、補上「沒送出」
  if (reason === broadcastLockText('none') || reason === broadcastLockText('basic')) {
    return `${reason}這則沒有送出任何訊息。`
  }

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
