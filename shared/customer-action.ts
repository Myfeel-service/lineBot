/**
 * 客人在 LINE 裡「做了什麼」——按了哪顆按鈕、從哪個活動登記、加了好友——寫成對話裡的一行紀錄。
 *
 * 為什麼需要：客人的動作在後台幾乎都是隱形的。文字訊息會存成一則泡泡，但
 *   · 按圖文選單／按鈕觸發模組（postback）**不會**存成訊息，
 *   · 按鈕代客人送出的那段文字也不會存（走 handleIncomingText，但那條路徑不存 incoming），
 *   · 活動連結登記 + 加好友只留下我們推出去的那則歡迎訊息。
 * 結果客服打開對話看到的是「我們自己先開口講了一段話」，完全看不出客人做了什麼才觸發它；
 * AI 答錯時也無從判斷客人當時的處境（實測：客人點了「小耳記開賣通知」活動登記，
 * 接著問「請問何時開賣」，對話上只有我們的推播，沒人看得出那句話是在問哪個產品）。
 *
 * 這些紀錄是**寫進訊息子集合的一則 messageType='customer_action'**，不是 conversationEvents：
 *   · 對話頁（訊息流）與會話時間軸讀的是同一份資料，一次寫入兩邊都看得到、時序天生正確
 *   · 不必為了在訊息之間插入事件而多一次查詢／多一個複合索引
 * 但它刻意**不更新對話文件**（lastMessage / lastMessageAt / lastPeerActivityAt）——
 * 見 saveConversationMessage 的 traceOnly：一行操作紀錄不該蓋掉列表上「客人最後說了什麼」，
 * 也不該把對話推成未讀、更不該讓客人點一下就開一場新會話。
 */

/** 這一則訊息是「客人動作紀錄」而不是真的訊息 */
export const CUSTOMER_ACTION_MESSAGE_TYPE = 'customer_action'

export type CustomerActionType =
  /** 按鈕／圖文選單觸發機器人模組（有回覆送出） */
  | 'button_module'
  /** 按鈕代客人送出一段文字（客人自己沒有打字） */
  | 'button_message'
  /** 按了按鈕，但一則回覆都沒送出（指向的模組被刪／停用，或沒有對應規則） */
  | 'button_dead'
  /** 加入好友（含封鎖後重新加回） */
  | 'follow'
  /** 從活動連結登記（LIFF claim 套用時） */
  | 'campaign_claim'
  /** 取消好友／封鎖官方帳號 */
  | 'unfollow'

/** 名稱太長會把那一行撐開換行，超過就截斷（完整內容在訊息 payload 裡） */
const NAME_MAX = 40

function quoted(name: string | undefined | null): string {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ')
  if (!clean) return ''
  return clean.length > NAME_MAX ? `${clean.slice(0, NAME_MAX)}…` : clean
}

/**
 * 那一行要顯示的字。**存進訊息的 `text` 欄位**（不是只在前端算）：
 * 以後改文案不會讓已經存下來的紀錄變成空白，讀 `text` 的地方（時間軸、匯出）也都拿得到字。
 */
export function customerActionLabel(input: {
  type: CustomerActionType
  name?: string | null
  moduleId?: string | null
}): string {
  const n = quoted(input.name)
  switch (input.type) {
    case 'button_module':
      return n ? `客人點了「${n}」` : '客人點了按鈕'
    case 'button_message':
      return n ? `客人點了按鈕送出「${n}」` : '客人點了按鈕送出一段文字'
    // 有 moduleId＝按鈕指向的模組被刪／停用（後台改得到）；沒有＝找不到對應的回覆內容。
    // 兩種的修法不同，所以話要講不一樣（口徑同 timeline 的 postback_no_reply 舊事件）。
    case 'button_dead':
      return input.moduleId
        ? '客人點了按鈕，但指向的內容已失效（沒有回覆送出）'
        : '客人點了按鈕，但沒有對應的回覆內容（沒有回覆送出）'
    case 'follow':
      return '客人加入好友'
    case 'campaign_claim':
      return n ? `客人從活動「${n}」登記` : '客人從活動連結登記'
    case 'unfollow':
      return '客人取消好友或封鎖官方帳號'
  }
}

export function isCustomerActionMessage(messageType: unknown): boolean {
  return String(messageType ?? '') === CUSTOMER_ACTION_MESSAGE_TYPE
}
