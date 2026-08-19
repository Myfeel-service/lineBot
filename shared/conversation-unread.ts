/**
 * 未讀紅點的規則——**唯一一份**。列表五個分頁、分頁標題的數字、「全部已讀」都走這裡。
 *
 * 口徑（2026-08-19 老闆拍板）：**客人講過話就要看得到，直到有人真的看過那段對話。**
 *
 * 舊口徑是「最後一則是客人送的」，也就是把紅點當待辦：AI 或機器人回完就算處理掉了。
 * 實際跑起來會這樣——客人 09:00 問「這個多少錢」、AI 09:00:03 答完，那一列的最後一則
 * 就變成「我們回的」，紅點的條件當場不成立；左側清單 30 秒才刷一次，中間那 3 秒畫面上
 * 根本不會出現。結果是開著 AI 的帳號，紅點幾乎只在 AI 沒回、勿擾時段、客人連傳兩則時
 * 才亮，「機器人」分頁實質上永遠是乾淨的——但 AI 答錯的那些正好都躺在那裡。
 *
 * 新口徑只問兩件事，兩件都不管中間誰回過話：
 *
 * 1. 客人最後一則**訊息**是什麼時候（`customerLastMs`）。
 * 2. 那則有沒有晚於我看過的時間（`readMs`）。
 *
 * ⛔ 比較的欄位與蓋已讀章的來源**必須是同一族時間戳**（都取客人那側的訊息時間）。
 * 客人來訊蓋的是 LINE 事件時間、我們回覆蓋的是伺服器時間，兩邊混用的話：webhook 遲送、
 * 或客人跟我們幾乎同時發話時，新進來那則的時間會早於已讀基準 → 那一列有摘要、有
 * 「客人：」前綴，就是永遠不會亮紅點。同一位客人的 LINE 事件時間彼此是遞增的，
 * 兩邊都只吃這一族就不會有這回事。
 */

/** 判斷一列要不要亮紅點所需的全部資料（時間一律先轉成 epoch ms，0 ＝沒有這個值） */
export interface UnreadRowTimes {
  /**
   * 客人最後一則訊息的時間。來自對話文件的 `lastInboundMessageAt`
   * （只有客人真的傳訊息時才寫，按鈕／切選單不算，見 handler.ts 的 saveConversationMessage）。
   */
  customerLastMs: number
  /** 這一列最後一則訊息的時間（不分方向）：只在沒有 `customerLastMs` 時當退路 */
  lastMessageMs: number
  /** 這一列最後一則訊息是誰送的：只在沒有 `customerLastMs` 時當退路 */
  lastDirection?: string
}

/**
 * 這一列「客人最後開口」是什麼時候（epoch ms）；0 ＝客人沒開過口，或這一列不該亮。
 *
 * 舊資料退路：`lastInboundMessageAt` 是 2026-08-19 才開始寫的，在那之前的對話一律沒有這欄。
 * 沒有就退回舊口徑（最後一則是客人送的才算），於是**部署當下畫面完全不會變**——
 * 舊對話維持原本的行為，客人下次開口才換成新規則。反過來若用「猜的」去回填，
 * 部署那一刻整排會無預警全紅，沒有人分得出哪些是真的沒看過。
 */
export function customerLastMessageMs(row: UnreadRowTimes): number {
  if (row.customerLastMs > 0)
    return row.customerLastMs
  return row.lastDirection === 'outgoing' ? 0 : row.lastMessageMs
}

/**
 * 這一列要不要亮紅點。
 *
 * `readMs` ＝這位客人的已讀時間（見 AdminPanel.vue 的 convLastReadMs），
 * 一樣只吃客人那側的訊息時間。
 */
export function isConversationUnread(row: UnreadRowTimes, readMs: number): boolean {
  const ms = customerLastMessageMs(row)
  return ms > 0 && ms > readMs
}
