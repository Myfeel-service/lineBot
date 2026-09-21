/**
 * 好友頁 →「推播給這 N 位」→ 推播頁 的名單交接（`C-210`）。
 *
 * **它解的問題**：推播頁白紙黑字寫著「想寄給『兩個條件都符合』的人，目前要先到『好友』頁
 * 篩出那批人」——但好友頁篩完之後**沒有任何按鈕可以把那批人帶去推播**（批次列只有
 * 加標／移標／取消選取）。照著那句話做，會走到底才發現是死路。
 *
 * ⛔ **刻意不在好友頁就建一筆推播草稿**：那會在使用者還沒決定要發什麼之前先寫一筆資料進去，
 *    半途反悔就留下一堆空草稿。改成把名單暫存在瀏覽器、推播頁開一張**還沒存檔**的新推播。
 *
 * ⚠️ `sessionStorage` 是**這個瀏覽器分頁自己的**東西：無痕視窗、擋了網站資料、或使用者
 *    自己另開分頁貼網址，都可能讀不到。所以讀不到的時候要**講出來**（「名單沒有帶過來」），
 *    ⛔ 不可以安靜地開一張空白推播——那會讓人以為系統把他選的 300 個人記住了。
 */

/** sessionStorage 的鍵。⛔ 帶前綴：這個網域上還有別的功能在用 sessionStorage */
export const BROADCAST_AUDIENCE_HANDOFF_KEY = 'minime:broadcast-audience-handoff'

/** 交接單多久算過期。超過就當沒有——隔天回來還套用昨天選的名單是最難察覺的錯 */
export const BROADCAST_AUDIENCE_HANDOFF_TTL_MS = 10 * 60 * 1000

export interface BroadcastAudienceHandoff {
  /** LINE 的 U 開頭編號（推播的「匯入名單」吃的就是這個） */
  userIds: string[]
  /**
   * 勾了、但**找不到 LINE 編號**而被丟掉的筆數。
   * ⛔ 一定要帶：這是「過濾掉東西要說得出丟了什麼」那條規則——
   *    畫面上勾了 50 位、只帶過去 48 位而不吭聲，那兩位會安靜地收不到訊息。
   */
  dropped: number
  /** 建立時間，用來判斷過不過期 */
  ts: number
}

export function isFreshHandoff(
  payload: BroadcastAudienceHandoff | null,
  now = Date.now(),
): payload is BroadcastAudienceHandoff {
  if (!payload) return false
  if (!Array.isArray(payload.userIds) || payload.userIds.length === 0) return false
  if (typeof payload.ts !== 'number') return false
  return now - payload.ts <= BROADCAST_AUDIENCE_HANDOFF_TTL_MS
}

/** 解析交接單；⛔ 任何壞掉的內容一律當成「沒有」，不要讓一段壞 JSON 炸掉整個推播頁 */
export function parseHandoff(raw: string | null): BroadcastAudienceHandoff | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<BroadcastAudienceHandoff>
    const userIds = Array.isArray(parsed.userIds)
      ? parsed.userIds.map(id => String(id ?? '').trim()).filter(Boolean)
      : []
    if (!userIds.length) return null
    return {
      userIds,
      dropped: Number.isFinite(parsed.dropped) ? Number(parsed.dropped) : 0,
      ts: Number.isFinite(parsed.ts) ? Number(parsed.ts) : 0,
    }
  }
  catch {
    return null
  }
}

/** 交接完成後要給使用者看的那句話（純函式，兩邊共用、可測） */
export function handoffNoticeText(payload: BroadcastAudienceHandoff): string {
  const base = `已帶入 ${payload.userIds.length} 位好友當發送對象`
  if (payload.dropped > 0) {
    // ⛔ 被丟掉的要講出來，而且要講「為什麼」與「怎麼補」
    return `${base}；⚠️ 有 ${payload.dropped} 位沒有帶過來（查不到他們的 LINE 編號，多半是剛同步還沒補齊），`
      + '要發給他們請回好友頁重新勾選。'
  }
  return `${base}。`
}
